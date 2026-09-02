# Spec R2 - adversarial design review (reviewer A, continued)

Spec under review: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md` (revised).
Also read: `adjudications.md`, `spec-r1-reviewer-b.md`.
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.

The four blocking findings from round 1 that I raised are closed in substance. The
revision is not, however, safe: **five of the eight most serious defects below were
created by the revision itself**, and one blocking round-1 finding (B's F4) was
silently lost in the adjudication pairing and never fixed.

The sharpest of them is R2-1: the gate added in Sec 4.8 to close A6/B14 caps the
relay retry ladder at exactly one retry, which contradicts Sec 4.6's cap of 3 and
makes Sec 7 test 6 unproducible. The fix broke the thing it was protecting.

---

# Part I - new defects

## R2-1. [BLOCKING] Sec 4.8's new gate caps the relay ladder at ONE retry - the fix breaks the ladder it protects

**What is wrong.** Sec 4.8 (new this revision) says: "the relay retry is claimed
only when `updateRecipientDeliveryStatus` actually transitioned the slot." Trace the
second rung.

| step | slot status | `updateRecipientDeliveryStatus(…, 'undelivered')` | claim? |
|---|---|---|---|
| attempt 1's 30003 | `sent` | `undelivered` IS allowed from `sent` -> **true** | yes, `retry_attempts` -> 1 |
| attempt 2 sends | `undelivered` (nothing writes it back; Sec 4.7 permits only lineage child writes and the scoped delivered promotion) | - | - |
| **attempt 2's 30003** | `undelivered` | `undelivered` is **not** an allowed prior for `undelivered` -> **false** | **no claim, no attempt 3** |

**Evidence.**

- `app/src/repos/messagesRepo.ts:127` - `undelivered: ['queued', 'sent']`.
  `undelivered` is not a prior for itself.
- `app/src/repos/messagesRepo.ts:2805-2812` - a non-allowed prior returns `false`
  and logs "transition skipped (would regress)".
- Spec Sec 4.7 explicitly refuses to loosen `ALLOWED_PRIOR` and adds only
  `resolveRetryDelivered` (`undelivered -> delivered`). There is no specified path
  back to `queued` or `sent`, so the slot is pinned at `undelivered` for the rest of
  the chain.

**Implies.** The ladder delivers exactly one retry, permanently. Sec 4.6's cap of 3
and its whole quiet-hours argument (which is built on a 3-rung ~7-minute bound) are
dead letters; `retry_attempts` never exceeds 1; Sec 7 test 6 ("the exhausted chain
is terminal-undelivered") cannot be produced, because the chain terminates at rung 1
by accident rather than by cap. The duplicate-suppression Sec 4.8 wants and the
multi-rung ladder Sec 4.6 wants need two different discriminators. The right one is
almost certainly the lineage: claim iff `retry_lineage.<mk>.<n>` for the callback's
own `n` has not already resolved - which is per-attempt and therefore idempotent
across duplicates AND permissive across rungs. Whatever is chosen, Sec 4.8 as
written cannot be built.

---

## R2-2. [BLOCKING] The three new sibling maps are never seeded, and DynamoDB will not create an intermediate document path

**What is wrong.** Sec 3.1 introduces `fanout_attempts`, `retry_attempts` and
`retry_lineage` as top-level maps, and Sec 3.3 claims with a single
`ADD <field>.#k :one`. Sec 3.5 says "No backfill migration". Nothing anywhere
creates the parent map. A nested update whose parent path is absent is a
`ValidationException`, not a condition failure - and this repo has already been bitten
by it and documented the workaround twice.

**Evidence.**

- `app/src/repos/conversationsRepo.ts:2218-2226` states the rule outright:
  "DynamoDB rejects a `REMOVE relay_opted_out_members.#mk` whose parent map is
  ABSENT (the document path is invalid for update -> ValidationException)".
- `app/src/repos/conversationsRepo.ts:2174-2214` is the in-repo pattern for exactly
  this situation - a sibling map that is NOT pre-seeded. It needs **two** writes: a
  child SET guarded by `attribute_exists(relay_opted_out_members)`, and on the
  resulting `ConditionalCheckFailedException`, a second write that seeds the whole
  map. `claimAttempt` as specified is one write.
- The two writers the spec cites as the reason to move (`setRecipientDelivery`,
  `setRecipient`) are safe today only because their parents ARE pre-seeded -
  `messagesRepo.ts:2767-2776` and `broadcastsRepo.ts:585-592` both say so explicitly,
  and `app/src/routes/api.ts:1761-1766` / `app/src/services/groupSend.ts:581-583`
  are the seeding sites. The new maps have no equivalent.

**The error handling makes it worse, not better.** Sec 3.3's condition uses
`attribute_not_exists` for the zero case. If `fanout_attempts` itself is absent,
`attribute_not_exists(fanout_attempts.#k)` is TRUE, so the condition PASSES and the
update then fails on the path - a `ValidationException`, which Sec 3.3's
"On `ConditionalCheckFailedException`, a strongly consistent read disambiguates"
never catches. The job throws. Under Sec 3.4's new consumer-side rule that throw is
**correct behavior**, so SQS redelivers, and the claim fails identically every time
until `maxReceiveCount` (`infra/modules/jobs/main.tf:41`, = 5) DLQs it -
`visibility_timeout_seconds = 120` (`:36`), so ~8 minutes of a broadcast stuck
"Sending" with recipients `queued`. That is the exact non-terminal loop this branch
exists to remove, now guaranteed on the first claim against every pre-existing item
rather than merely possible.

`retry_lineage.<memberKey>.<n>` is worse still: **two** missing levels. Sec 4.2's own
argument for a map over a list - "A list cannot be created or extended by a nested
child-field update" - applies verbatim to `retry_lineage` and to
`retry_lineage.<memberKey>`. The revision fixed the problem at depth 3 and
reintroduced it at depths 1 and 2.

**Implies.** The spec must state the seeding rule: either seed the maps at
`markSending` / message-append time (both already seed their sibling map, so this is
a one-line addition at a site the spec must then admit to scope), or specify
`claimAttempt` as the documented two-write pattern with the
`attribute_exists(<field>)` guard. Sec 7 needs a test that claims against an item
written **before** this branch - see R2-17.

---

## R2-3. [BLOCKING] A stale duplicate section survived the revision and re-asserts the design the revision exists to remove

**What is wrong.** The spec has **two sections numbered 3.4**, and the second one is
pre-revision text that contradicts Sec 3.1.

**Evidence.**

- Line 161: `### 3.4 The handler shape - and why the close rule SPLITS`.
- Line 193: `### 3.5 Read-compat` - the new, correct one ("A missing entry in a
  counter map is zero").
- Line 199: `### 3.6 The 1:1 site`.
- **Line 207: `### 3.4 Read-compat`** - a second 3.4, and its body at line 209 reads
  "**A slot with no `attempt` attribute** is treated as zero and claimed to 1." That
  is the slot-resident counter Sec 3.1 spends 30 lines proving is a silent no-op.
- Line 214: `### 3.7`.

**Implies.** A builder who reads linearly hits the rejected design last and
implements it - reintroducing A1/B1, the round's most valuable finding, and Sec 7
test 0 is the only thing standing between that and a merge. The cross-reference at
line 233 ("both fan-outs are consumer-side (Sec 3.4)") is also now ambiguous between
the two 3.4s. Delete lines 207-212 and renumber.

---

## R2-4. [BLOCKING] B's F4 (cap off-by-one) was mis-paired in the adjudications, never adjudicated, and is not fixed

**What is wrong.** The adjudication file heads a section "**A4 / B4** - one field, two
retry budgets". Those are two DIFFERENT findings. My A4 was the shared-counter
defect; B's F4 is the cap **arithmetic**: the durable claim counts enqueues where
`payload.attempt` counts passes, so the same cap number buys one extra send pass per
recipient. B has no two-budget finding at all. F4 was absorbed into a resolution that
does not address it and appears nowhere else in the adjudications.

**Evidence - the arithmetic, verified.**

- Today: `app/src/jobs/broadcastFanOut.ts:479-480` -
  `nextAttempt = (payload.attempt ?? 1) + 1; if (nextAttempt > 3)`. Pass 1 enqueues
  pass 2; pass 2 enqueues pass 3; pass 3 computes 4 > 3 and caps. **Three send
  passes.** Identical at `app/src/jobs/relayFanOut.ts:570-571` against
  `MAX_FANOUT_ATTEMPTS` (`:58`).
- Revised Sec 3.3: `ADD` guarded on "the count is below `cap`", zero-case via
  `attribute_not_exists`. With `cap = 3` (Sec 3.2 states the fan-out ladder as
  "cap 3"): pass 1 claims 0->1 and enqueues pass 2; pass 2 claims 1->2 and enqueues
  pass 3; pass 3 claims 2->3 and enqueues **pass 4**; pass 4's claim fails 3<3 and
  closes. **Four send passes.**
- The 1:1 site does not have the skew - `app/src/routes/webhooks/twilio.ts:2556-2557`
  tests `priorAttempt >= MAX_SEND_RETRY_ATTEMPTS` against a count of retries already
  performed - which is exactly why one uniform word "cap" reads safe at all three
  sites and is not.

**Implies.** Sec 3.2's own sentence "it does not change the effective retry budget"
is false by one send per recipient, against a registered A2P tier and a token bucket
sized for the current rate. On a 1500-recipient broadcast
(`app/src/repos/broadcastsRepo.ts:66`, `MAX_BROADCAST_RECIPIENTS = 1500`) that is up
to 1500 extra provider sends. The spec must state the literal value passed to
`claimAttempt` at each of the three sites and Sec 7 needs a test pinning provider
sends per recipient before and after. This is a correctness regression introduced by
the fix, hiding behind a word that means two different things at two sites.

---

## R2-5. [BLOCKING] Announcement legs carry relaysid pointers, so the new retry path reaches into `tourReminders.ts` - a Sec 2 hard fence

**What is wrong.** Sec 4 assumes a relaysid pointer identifies a **fan-out leg of a
relayed member message**. It does not. Every persisted relay ANNOUNCEMENT leg writes
one too, and those resolve through the same `/status` relay branch the new 30003
handling is being added to.

**Evidence.**

- `app/src/services/relayAnnouncements.ts:288-293` - `putRelaySidPointer` per member
  on every `persist` announcement leg.
- Callers of `sendRelayAnnouncement`: `app/src/jobs/relayFanOut.ts:641` (intro),
  `:687` (member-added), `app/src/routes/relayGroups.ts:600` (group-closed),
  `app/src/routes/api.ts:979`, and **`app/src/jobs/tourReminders.ts:1267`** (tour
  reminder rungs; the route comment at `app/src/routes/tourReminders.ts:125` confirms
  "GROUP route: per-member provider sends via sendRelayAnnouncement").
- `app/src/routes/webhooks/twilio.ts:2409` resolves ANY relaysid pointer and
  `:2433-2437` dispatches it to `handleRelayRecipientStatus` - the branch Sec 4.8
  adds the claim to. Nothing distinguishes an announcement leg from a fan-out leg.
- Sec 2's hard fences: "**`jobs/tourReminders.ts`** - owned by
  `feat/tour-reminder-ladder-phase-b`."

**Implies, three ways.**

1. **Fence violation without an edit.** A 30003 on a tour-reminder rung now schedules
   a `relay.retrySend` 60s later. The branch changes tour-reminder send behavior
   through a shared seam while claiming not to touch the file - and the ladder branch
   is concurrently rewriting supersession semantics for exactly those rungs.
2. **Body corruption.** Sec 4.3 reconstructs the outbound as
   `composeRelayBody(senderLabel, body)`. An announcement body is already complete
   (`composeIntroBody`, `composeMemberAddedBody`, a rung). Prefixing it with
   `"<senderLabel>: "` produces a message no send path has ever produced.
3. **No lineage to read.** An announcement leg has no `retry_lineage` entry at all
   (see R2-6), so `senderLabel` and `sentTo` are both absent and Sec 4.3/4.5 have
   nothing to work with.

The spec must state how the relay branch distinguishes a retryable fan-out leg from
an announcement leg. `relay_sender_key` on the source message is the obvious
discriminator (`system` / `team` sentinels are documented at
`dashboard/src/api/types.ts:2354-2357`), but it has to be named and the announcement
case has to be explicitly excluded.

---

## R2-6. [HIGH] Nothing writes `retry_lineage.<memberKey>.1`, and there is no read-compat rule for a leg sent before this branch

**What is wrong.** Sec 4.3 reads `senderLabel` from
`retry_lineage.<memberKey>.<n>.senderLabel`; Sec 4.5 compares against the stored
`sentTo`. Both are attempt-1 facts. Only the FAN-OUT knows them, and Sec 2 scopes
`relayFanOut.ts` to "durable per-recipient attempt count" - nothing about writing
lineage. No section says attempt 1's entry is created, by whom, or when.

**Evidence.**

- `app/src/jobs/relayFanOut.ts:538-549` is the only place that holds all three facts
  at once: `result.providerSid`, `member.phone`, and the resolved
  `senderName`/`senderLabel` (`:405`, `:410-411`). It currently writes a slot and a
  pointer, nothing else.
- Sec 4.2's read-compat sentence covers **only** the pointer ("a pointer with no `n`
  is attempt 1"). The lineage gets none.
- Sec 3.5: "No backfill migration."

**Implies.** Every relay leg already sent - and every leg in flight at deploy - has no
lineage. Its first 30003 finds no `senderLabel` (Sec 4.3 forbids the roster fallback
that would otherwise cover it) and no `sentTo` (so Sec 4.5's refusal cannot be
evaluated). The spec must say what happens: refuse the retry for a leg with no
lineage, or fall back and accept the drift. Either is fine; silence is not, and this
is not a corner case - it is the entire installed base on day one. It also adds a
writer to `relayFanOut`'s scope line and a fourth per-leg write to the fan-out's
inner loop, which Sec 9 lists as a conflict surface.

---

## R2-7. [HIGH] Sec 3.6's 1:1 "producer-side close" already ships - the A3 error, repeated in the section written to fix A7

**What is wrong.** Sec 3.6 states the 1:1 defect as: "if `enqueueSendRetry` throws in
the webhook, no retry is ever scheduled, and the dashboard goes on promising one.
That is a producer-side failure by the table above, so it closes immediately."
Sec 3.7's table gives the close as "leave the message terminally undelivered".
Both halves of that fix are already the shipped behavior.

**Evidence.**

- `app/src/routes/webhooks/twilio.ts:2551` opens a `try` around the entire
  error-code switch, and `:2727-2731` closes it:
  `catch (err) { log.error({ err, providerSid, errorCode }, 'delivery-error side effect failed'); }`
  with the comment "Side-effect failures never 5xx the callback". A throwing
  `enqueueSendRetry` (`:2567`) is already caught, already logged at ERROR (which
  feeds the `hc-<env>-error-logs` alarm), and the request already `res.status(200)`s
  at `:2733`.
- The message is already terminally undelivered: `updateDeliveryStatus` ran at
  `:2471`, well before the switch.

So the "close" is a no-op on a state that is already terminal and already alarmed.
The only genuine 1:1 delta left in the branch is Sec 8's chip copy - and Sec 8 made
that **unconditional**, so it fires whether or not an enqueue ever failed.

**Implies.** Sec 3.6 asserts a defect that does not exist, in the same shape as the
`finalize()` claim Sec 3.7 was written to retract. A builder will add a redundant
try/catch inside an existing try/catch and record it as a fix. Either state the real
residual gap precisely (there is one: the ERROR log is the only trace, and nothing
distinguishes "retry never scheduled" from "retry scheduled and failed later") or
drop `retrySend.ts` from Sec 2's scope list entirely, which is what B's F6 actually
recommended.

---

## R2-8. [HIGH] Sec 3.4's consumer-side rule covers only the ENQUEUE failure - Sec 1's invariant still answers NO on the unknown-error path

**What is wrong.** The new table's consumer-side justification is "The count already
advanced durably, so the redelivered envelope reaches the cap and closes." That is
true only when the throw happens AT the enqueue, i.e. after the claim. Both fan-outs
have a pre-existing, deliberate throw that fires **inside the recipient loop**, long
before the claim.

**Evidence.**

- `app/src/jobs/broadcastFanOut.ts:456-459` - "Unknown error: leave the recipient
  queued and let the job FAIL so SQS redelivers the whole envelope", then `throw err`.
- `app/src/jobs/relayFanOut.ts:531-535` - the identical ruling for relay.
- The claim, per Sec 3.4's shape, is taken at the continuation block - reached only
  after the loop completes.
- `infra/modules/jobs/main.tf:41` - `maxReceiveCount = 5`; `:36` -
  `visibility_timeout_seconds = 120`.

**Implies.** A recipient whose send fails with an unclassified error (a 500 from the
adapter, a network reset - neither is in `TRANSIENT_CODES` nor `UNREACHABLE_CODES`
nor 30007) throws the whole job on every redelivery, never advances any counter,
DLQs after 5 receives, and leaves the broadcast "Sending" forever with recipients
`queued` - the exact user-visible signature Sec 1 opens with. The invariant Sec 1
poses is not satisfied after this branch for that path. Say so explicitly (it is a
legitimate scope call to leave it), or the branch closes its anchor issue on a
narrower fix than the issue's own general invariant asks for.

---

## R2-9. [HIGH] `resolveRetryDelivered` splits the promotion into two non-atomic writes with no reconciler

**What is wrong.** Sec 4.7's new method is conditional on
"`retry_lineage.<memberKey>.<n>.status` being `delivered`" - a value the SAME callback
must have written a moment earlier. So the delivered promotion is: (1) write the
lineage entry, (2) call `resolveRetryDelivered`. Two round trips, no transaction.

**Implies.** A crash, a Lambda timeout, or a DynamoDB throttle between (1) and (2)
leaves the lineage saying `delivered` and the effective slot saying `undelivered`,
**permanently**. Nothing re-runs: Twilio will not re-send a successful delivery
receipt, and Sec 2 hard-fences "Twilio status polling / missed-callback
reconciliation" out of the branch. The headline guarantee - "A delivered attempt
wins permanently" - acquires a silent, unrecoverable failure window that the previous
revision (wrong as it was) did not have.

This is avoidable and the repo already shows how: a single `UpdateItem` can `SET`
both `delivery_recipients.#mk.#st = :delivered` and
`retry_lineage.#mk.#n.#st = :delivered` under one `ConditionExpression` on the slot's
current status - the same multi-clause hand-assembled shape as
`app/src/repos/messagesRepo.ts:2820-2850`. Specify the one-write form, or state the
window and why it is accepted.

**Also unspecified:** what happens to the slot's `errorCode`. A slot promoted
`undelivered -> delivered` that keeps `errorCode: '30003'` is a delivered leg
carrying a failure code. `presentRelayDelivery`
(`dashboard/src/routes/contact/deliveryStatus.ts:400-405`) filters only on
`contact_opted_out`, so it renders harmlessly today - but `T-DELIVERY-CHIPS` is
being handed this record as its input, and Sec 10 promises it "the lineage this
branch produces". Say whether the promotion clears it.

---

## R2-10. [HIGH] Sec 5.3's new inline rule finalizes a SHORT participant map, which Sec 5.4 (retained) says must never happen

**What is wrong.** The B16 fix created a fresh contradiction with a section that was
not rewritten. Sec 5.3: on the inline `groupSend` backstop, "**no ladder, no
repair.** A member the create did not refuse is treated as attached and the send
proceeds". Sec 5.4, unchanged: "a short map would send to a subset while the UI
showed the whole group and leave the absent member's receipts unattributable ... What
changes is only the CONCLUSION drawn from a short map."

The conclusion is not all that changes. The map that gets STORED changes too.

**Evidence.**

- `app/src/services/groupRail.ts:619-625` - `setTwilioConversation` persists
  `participantMap`, which is `buildParticipantMap(participants)` (`:506`), which
  omits every participant whose `address` has not propagated (`:224-231`). On the
  inline path with no ladder, that map is short at the moment it is stored.
- `app/src/services/groupSend.ts:648` - the send then snapshots that same short map
  onto the message as `groupRailSnapshot`, and the snapshot is PREFERRED over the
  thread's current map at receipt time (`app/src/services/groupReceipts.ts:254-259`).
- `app/src/services/groupReceipts.ts:375-388` - an unresolvable participant is
  dropped with `group_receipt_unknown_participant`.

**Implies.** Every receipt for the unbound member on **that message** is dropped
permanently, even after the job path converges the thread's map, because the message
carries its own frozen snapshot. Sec 5.4's assertion that the compose gate "is not
weakened" is false for the inline path Sec 5.3 just created. The spec must say what
the inline path stores: finalize with the short map and accept the dropped receipts
(then say so, and delete Sec 5.4's contrary sentence), or do not finalize inline at
all and let the job path be the only writer of the map.

---

## R2-11. [MEDIUM] Sec 3.4's producer-side justification is contradicted by the file's own comments

**What is wrong.** The new table's producer-side reason: "**Nothing redelivers a
webhook.** If the enqueue does not land, no later event will ever run the close."
The file being edited says the opposite, twice.

**Evidence.**

- `app/src/routes/webhooks/twilio.ts:2455-2457` - "Still ack 200 so Twilio doesn't
  redeliver into the same gap."
- `app/src/routes/webhooks/twilio.ts:2727-2729` - "Side-effect failures never 5xx the
  callback: **Twilio's redelivery** would no-op at the status transition anyway."

Both are written on the premise that a non-2xx status callback IS redelivered. Note
also that the relay branch returns at `:2436`, *outside* the `try` that starts at
`:2551` - so unlike the 1:1 arm, a throw in the new relay claim/enqueue escapes and
does 5xx the callback.

**Implies.** The conclusion (close now) may still be right, but the stated reason is
false, and a builder who believes "nothing redelivers" will not make the relay claim
idempotent against a redelivered callback - which is precisely what Sec 4.8 exists to
do. Restate the reason as "a webhook redelivery is not guaranteed and is not a
scheduling mechanism", and say explicitly that the relay branch must not throw.

---

## R2-12. [MEDIUM] Sec 8's unconditional copy change degrades the 1:1 and broadcast surfaces, which Sec 2's own fence forbids

**What is wrong.** `ERROR_CODE_REASONS` has three consumers, not one. Truncating
`'30003'` to `Phone unreachable` removes a promise that is currently TRUE on two of
them, purely to stop it being false on the third.

**Evidence.**

- 1:1: `app/src/routes/webhooks/twilio.ts:2567` genuinely enqueues a retry on a 30003
  under the cap. Today's chip is accurate there.
- Broadcast recipient badge: `dashboard/src/routes/broadcasts/BroadcastResults.test.tsx:145`
  and `dashboard/src/routes/broadcasts/StatChips.test.tsx:118` both assert
  `/Phone unreachable/i` renders on a broadcast leg. A broadcast leg is a 1:1 message
  with `broadcast_id`, so it too gets a real `messaging.retrySend`.
- Sec 2's fence: "**Native Twilio group-text receipts and the existing 1:1
  retry/collapse behavior** must not change merely because the dashboard presenter is
  shared."

**Implies.** This is the exact shape the fence names: a shared presenter dragging a
1:1 surface along for relay's benefit. Sec 8 argues "saying less is truthful in both
cases", which is true but is not the same as "nothing changes for 1:1". Either amend
the fence to admit the shared-copy change and own the 1:1 information loss, or scope
the truncation to the relay rollup's call site (`deliveryStatus.ts:416` - the only
caller that produces a relay leg's reason), which keeps the 1:1 bubble and the
broadcast badge intact and stays inside one file.

---

## R2-13. [MEDIUM] Sec 8's "preserved verbatim" instruction is incoherent, and nothing pins the change

**Evidence.** Sec 8: "the live string uses an em dash, and `deliveryReason` appends
an `(error 30003)` tail - **both must be preserved verbatim in whatever replaces
it**."

- The em dash is *inside* the clause being deleted
  (`dashboard/src/routes/contact/deliveryStatus.ts:544`,
  `'Phone unreachable — will retry'`). The replacement `Phone unreachable` has no
  dash. "Preserve the em dash verbatim" is unsatisfiable, and if a builder tries, the
  repo's ASCII rule for touched lines is violated too.
- The tail is not in the map value at all; it is appended by
  `deliveryReason` (`deliveryStatus.ts:638-640`). "Preserve it in whatever replaces
  the string" invites `'Phone unreachable (error 30003)'`, which renders a doubled
  tail.

**And nothing catches either mistake.** The two broadcast tests above match
`/Phone unreachable/i`, which passes for the old string, the new string, and the
doubled-tail string. `Timeline.delivery.test.tsx:385` only asserts `/will retry/` is
ABSENT on a `queued` row. Sec 7 has no dashboard test at all.

**Implies.** Rewrite the sentence as two instructions - "the map value becomes
`'Phone unreachable'` (ASCII); do not touch `deliveryReason`, whose `(error <code>)`
tail already satisfies 'the code stays exposed'" - and add a unit assertion on the
composed output.

---

## R2-14. [MEDIUM] The scoped delivered promotion bypasses the `transitioned` flag that gates the SSE emit

**What is wrong.** Sec 4.7 requires "the existing message-refresh event ... after each
**effective** transition". The existing emit is gated on the return value of
`updateRecipientDeliveryStatus`, which for a successful retry's `delivered` callback
returns **false** (it is a refused regression - that is the whole reason
`resolveRetryDelivered` exists).

**Evidence.** `app/src/routes/webhooks/twilio.ts:2389-2403` - `if (transitioned)`
guards both `events.emit('message.persisted', …)` and `flagPlacementAttention`.

**Implies.** As written, the one transition users most need to see live - a leg
flipping from failed to delivered on retry - emits nothing, and the thread updates
only on reload. `handleRelayRecipientStatus` has to be restructured so the emit is
driven by `resolveRetryDelivered`'s result OR `transitioned`. That is a real edit to
the `/status` relay branch that Sec 4.7's one-line rule does not convey.

---

## R2-15. [MEDIUM] Sec 4.9 adopts B14's `isTerminal` change without making the decision B asked for

**What is wrong.** Sec 4.9's closing paragraph: "The fan-out's skip set must treat
`undelivered` as terminal for its own purposes". B14 explicitly flagged the cost:
"changing `isTerminal` also changes behavior for legs with no retry, so it needs its
own decision." The revision took the change and dropped the decision.

**Evidence.** `app/src/jobs/relayFanOut.ts:158-160` - `isTerminal` is
`sent | delivered | failed`, and it is read at `:446` for the resume/continuation
skip. Today a continuation DOES re-send a leg sitting at `undelivered`. After the
change it never will - including a leg that reached `undelivered` from a code with no
retry ladder at all, and including the announcement legs of R2-5, which share the
slot shape but not the retry path.

**Implies.** State the intended rule for an `undelivered` leg with NO retry claimed:
is it now permanently skipped by continuations (a behavior change with its own blast
radius), or is the skip conditional on `retry_attempts.<mk>` existing? The latter is
narrower and matches the stated intent ("the retry ladder owns that recipient"), but
it is a different predicate than "treat `undelivered` as terminal".

---

## R2-16. [MEDIUM] Sec 5.2's 50386/50437 rule is unscoped and collides with Sec 5.4's adopt-path authority

**What is wrong.** Sec 5.2's bullets sit under "On a **freshly created** rail", but
bullet 3 reads "Per-member 50386/50437 **during repair** are success pending re-read"
with no path qualifier. Repair also runs on the adopt path, where Sec 5.4 keeps
"read-back as authoritative ... Twilio is the only source of roster truth there."

**Evidence.** `app/src/services/groupRail.ts:517-550` is a single repair block
reached from BOTH the create path and the adopt path (`:452-454` sets
`wasAdopted = true` and falls through to the same `missing.length > 0` check at
`:517`). There is no branch to hang a create-only rule on without adding one.

**Implies.** On an adopted rail we have no `failures` list, so a 50386 "already
exists" is the only positive evidence available - treating it as success is arguably
right there too. But Sec 5.4 says Twilio's read-back is the sole authority, and a
re-read that still comes back short after a 50386 has to resolve to something. Say
which rule wins on the adopt path.

---

## R2-17. [MEDIUM] No test in Sec 7 claims against an item written before this branch

**What is wrong.** Sec 7 test 0 is the right regression test for the slot-vs-sibling
question and I endorse it. But every test in Sec 7 operates on an item this branch's
own code created. The read-compat path - Sec 3.5's "No backfill migration" - is
exercised nowhere.

**Implies.** R2-2 (missing parent map) and R2-6 (missing lineage) are both
first-claim-against-a-legacy-item failures, and both would pass every listed test and
fail on the first real 30003 in dev. Add: "claim against a broadcast/message row
seeded WITHOUT the new maps" and "a 30003 on a relay leg with no `retry_lineage`".

---

## R2-18. [LOW] `fanout_attempts` competes with a documented, deliberately-sized item budget

**Evidence.** `app/src/repos/broadcastsRepo.ts:54-66` sizes
`MAX_BROADCAST_RECIPIENTS = 1500` against a 400KB item: "Each recipient slot is
contactKey (~40B) + a small object ... 1500 slots x ~200B ~= 300KB, leaving
comfortable headroom". `fanout_attempts` re-pays the ~40B key for every deferred
recipient on the same item. At 1500 keys that is ~60-75KB against ~100KB of stated
headroom.

**Implies.** Not fatal, and only deferred recipients get an entry. But the note is
explicit about the budget and Sec 3.1 spends the headroom without mentioning it. One
sentence, and prefer a shorter attribute name than `fanout_attempts` if it is close.

---

# Part II - contesting the adjudications

## A13 - relayFanOut's cap-close emits no refresh event. **CONCEDED.**

You are right that Sec 4.7 governs the retry lineage, not the pre-existing cap path,
and the revision does not change that path's reachability. Pre-existing gap, out of
scope. Withdrawn.

## A17 - `RELAY_PRESIGN_TTL_SECONDS`. **DEFENDED - the rejection is factually wrong.**

The rejection reads "no such constant exists to point at; the relay legs presign
inline." It does exist, exported, with a docblock:

- `app/src/jobs/relayFanOut.ts:65` -
  `export const RELAY_PRESIGN_TTL_SECONDS = 3600;`, documented at `:60-64` as
  "Outbound MMS presign TTL for relay legs (design Sec 7)".
- Used at `app/src/jobs/relayFanOut.ts:498`.
- Its 1:1 twin is `app/src/jobs/retrySend.ts:34`,
  `export const RETRY_PRESIGN_TTL_SECONDS = 3600;`.

The revision made this worse, not better: Sec 4.3 now says "at the same 3600-second
TTL the manual route and the relay legs use" - a bare magic number in prose where two
named exported constants exist. Downgrade to LOW if you like, but the correction
should be "import `RELAY_PRESIGN_TTL_SECONDS`", not a literal.

## A18 / B21 - `ReturnValues: 'UPDATED_NEW'` on a nested path. **PARTLY DEFENDED.**

The rejection says the sibling-map move "moots it". It does not. `fanout_attempts` is
a top-level MAP, so `ADD fanout_attempts.#k :one` is still a nested-path update and
`UPDATED_NEW` still returns the enclosing `fanout_attempts` attribute - up to 1500
entries on a large broadcast, on every claim.

More usefully: the revision **deleted the `ReturnValues` clause entirely** from
Sec 3.3 while keeping `{ outcome: 'claimed'; attempt: number }` in the signature. The
spec no longer says how `claim.attempt` is obtained at all - and `claim.attempt` is
load-bearing, because Sec 3.4 feeds it to the backoff selector. That is a new gap
created by the edit. LOW, but it needs one sentence.

## A19 / B20 - shared slot type and the mirrored dashboard type. **CONCEDED, and the fix is better than I gave it credit for.**

The sibling-map move genuinely closes both halves, and I verified the second one you
did not: `app/src/routes/contactTimeline.ts:415-435` is an explicit field-by-field
projection, not a spread, so a new top-level `retry_lineage` does **not** ship to the
browser. B20's "lineage ships uninspected" concern is fully moot, which is worth
recording so a later round does not re-raise it.

## B17 - the new rail authority is vacuous on the bulk create path. **DEFENDED - B was right and the rejection is factually wrong.**

The rejection says "B did not show a create path that returns no failures list."
B cited it and it is there:

- `app/src/adapters/groupConversations.ts:486` -
  `return { conversation: toConversationRef(created), participants: attached, failures: [] };`
  on the bulk `ConversationWithParticipants` success path. Unconditional empty array.
- Real per-member refusals come only from the individual-adds fallback
  (`:539-541` via `attach` at `:545-570`).

So on the bulk path, "a member the create did NOT refuse is attached" degenerates to
"everyone, always" - which is SAFE, but only because of the all-or-nothing property
documented at `:503-506` ("the bulk create is all-or-nothing: ONE rail-ineligible
member fails the whole request with no per-member detail").

The revision compounds this. Sec 5.2 cites the authority as
"`createConversationWithParticipants`, **groupConversations.ts:539-569**" - that
range is the *individual-adds* path. The spec cites the fallback as the authority for
a rule it applies to both paths, and never states the all-or-nothing premise the bulk
path's safety rests on. B's remedy stands verbatim: state the premise, and state what
happens if Twilio ever returns partial success there.

## B18 - Sec 6's disposition rule collides with the fences. **DEFENDED - the revision did not fix the half you rejected.**

You accepted the bounding and rejected the collision. The collision survives the
rewrite word for word. Sec 6 now reads: "Disposition follows Sec 2's fences, which it
does not override: **inside M5's anchor files** -> fixed here". Sec 2's fences are by
REGION, not by file: `twilio.ts` is an anchor file but only its `/status` handler is
in scope. A provider-status finding elsewhere in `twilio.ts` is "inside an anchor
file" and outside the fence simultaneously - which is exactly the ambiguity B named.
One-word fix: "inside M5's in-scope REGIONS".

---

# Verified-correct in the revision (so a later round does not re-litigate)

- Sec 3.1's diagnosis of the whole-slot writers is accurate and the sibling-map
  resolution genuinely closes A1/B1 - `messagesRepo.ts:2777-2785`,
  `broadcastsRepo.ts:584-605`.
- Sec 3.7's retraction of the `finalize()` claim is correct;
  `app/src/jobs/broadcastFanOut.ts:493` has always called it.
- Sec 4.7's diagnosis is exactly right: `ALLOWED_PRIOR.delivered = ['queued','sent']`
  at `messagesRepo.ts:126`, no `undelivered` predecessor.
- Sec 4.9's fan-out-redelivery trap is real AND the fix works on the path that
  matters: `relayFanOut` re-reads the source message fresh at `:382-390` on every
  delivery, so a redelivered envelope sees the current slot status (the skip is not
  against a stale snapshot).
- Sec 4.2's map-over-list argument is correct and matches the repo's own child-write
  discipline - `messagesRepo.ts:2814-2819`.
- Sec 3.3's strongly-consistent disambiguating read correctly closes B12.
- Sec 4.3's registration/metering paragraph matches
  `app/src/jobs/registerHandlers.ts:31-44`, which does document `retrySend` as the
  deliberate un-metered exception and both fan-outs as token-bucket consumers
  (`:46-48`).
- Sec 8's factual note about the em dash and the `(error 30003)` tail is correct as
  fact (`deliveryStatus.ts:544`, `:638-640`); only the instruction built on it is
  broken - see R2-13.
- Sec 9's new watch item preserving `relayFanOut`'s continuation-backoff off-by-one
  (A12) is the right call and correctly cites the divergence.
