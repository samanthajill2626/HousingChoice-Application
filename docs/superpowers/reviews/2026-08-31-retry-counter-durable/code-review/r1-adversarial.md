# Adversarial review - feat/retry-counter-durable @d2d15b4e

Fresh-eyes, read-only review of the branch's own diff against merge base
`1af02926`. Scope built independently (`git log`/`git diff` over `app/`,
`dashboard/`, `e2e/`); intended behaviour derived from the code and tests, not
from the branch's own design docs (those were read only to check whether a
stated justification survives contact with the code it cites).

Empirical work performed:

- `cd dashboard && npx vitest run src/routes/contact/deliveryStatus.test.ts src/routes/contact/Timeline.delivery.test.tsx` -> 109/109 pass.
- `cd app && npx vitest run test/relayFanOut.test.ts test/broadcastFanOut.test.ts` -> 97/97 pass.
- No suite was left running; no full gate was started (a full e2e gate is live on this machine).

**Counts: 0 must-fix, 3 should-fix, 6 notes.**

---

## SHOULD-FIX 1 - the "will retry" promise is still false on every native group-text LEG, and D20's stated reason for exempting group text does not hold

**Files:** `dashboard/src/routes/contact/deliveryStatus.ts:590-612` (the
`RELAY_ERROR_CODE_REASONS` docblock and map), `dashboard/src/routes/contact/Timeline.tsx:852-867`,
`dashboard/src/routes/contact/Timeline.tsx:1058-1069`,
`dashboard/src/routes/contact/Timeline.tsx:584-589`.

**The claim under review.** `deliveryStatus.ts:597-602` states:

> NATIVE GROUP TEXT IS DELIBERATELY EXCLUDED (D20) ... A group text's 30003
> retry is real: the 30005/30006 and 21610 arms of the webhook each carry a
> group_text guard and the 30003 arm carries none, so a group-text leg reaches
> the retry enqueue exactly as a 1:1 does.

**Why it is wrong.** The premise conflates two different receipt paths.

1. `enqueueSendRetry` has exactly one caller in the app: the `/status` route's
   `case '30003'` arm, `app/src/routes/webhooks/twilio.ts:2553`. That arm is
   reached only after `message = await messages.getByProviderSid(MessageSid)`
   resolves a MESSAGE ROW (`twilio.ts:2406`). It is a whole-MESSAGE retry.
2. A native group text's PER-LEG delivery state is not written there at all. It
   is written by `app/src/services/groupReceipts.ts:422`
   (`applyReceipt` -> `messages.updateRecipientDeliveryStatus(..., effectiveErrorCode, { context: 'group' })`),
   fed by the Conversations delivery-receipt route. Grepping
   `RETRY_SEND_JOB|messaging.retrySend` across `app/src` returns no hit in
   `groupReceipts.ts` and no hit anywhere else that could retry a leg.

So no per-recipient slot anywhere in this codebase - relay or group text - is
followed by a retry. The branch fixed relay and left the identical falsehood
live for group text, with a comment asserting the opposite.

**It also reaches the message-level chip the diff deliberately left un-flagged.**
`Timeline.tsx:852-865` argues the message-level site is safe because "the code
that does reach it is the native-group-text aggregate, whose 30003 retry is real
(D20)". But that aggregate is derived from LEGS:
`groupReceipts.rollUpAggregate` (`app/src/services/groupReceipts.ts:336-357`)
calls `deriveGroupDeliveryStatus`
(`app/src/services/groupDelivery.ts:98-120`), which copies **the worst leg's
`errorCode`** onto the message row via `messages.updateDeliveryStatus(provider_sid, rollup.status, rollup.errorCode)`.
So `msg.error_code === '30003'` on a group_text row can be a leg's code that
nothing retried, and the message-level chip prints "will retry" for it.

**Concrete failure scenario.** Native group text to Ann and Bo. Bo's handset is
off; Twilio's Conversations delivery receipt for Bo's leg arrives
`undelivered / ErrorCode 30003`. `applyReceipt` writes
`delivery_recipients['<Bo>'] = { status: 'undelivered', errorCode: '30003' }`
and no retry is scheduled. `rollUpAggregate` then stamps
`error_code: '30003'` on the message row. The thread now shows, at four
positions: rollup chip `delivered 1/2 - 1 failed - Phone unreachable - will
retry (error 30003)`, the same string in the chip's accessible name, the same
string on Bo's row, and the message-level chip. Staff read "will retry" as
"leave this alone, it is still going" - the exact misread D19 was written to
stop - and nobody ever re-sends to Bo.

**Empirical evidence.** `dashboard/src/routes/contact/Timeline.delivery.test.tsx:517`
("keeps the retry promise on the SAME leg in a native GROUP TEXT") asserts
exactly this string and **passes** in the run above. The test pins the defect
rather than catching it.

**Fix direction.** The override is scoped to the wrong axis. It is not "relay
vs group text", it is "a LEG code vs a MESSAGE code" - no leg is ever retried
and every message-level 1:1 30003 is. Either pass `relay: true` for both
multi-party leg positions (and rename the option `leg`), or add `'30003'` to a
leg-scoped map consulted whenever `row.slot.errorCode` is the source. The
message-level site additionally needs the group_text aggregate case handled,
since its code can be leg-derived.

**Regression test that would fail today.** Invert
`Timeline.delivery.test.tsx:517`: render the same message with
`rosterKind: 'group_text'` and assert
`expect(within(failedRow).getByText('Undelivered - Phone unreachable (error 30003)'))`
plus `expect(screen.queryByText(/will retry/)).not.toBeInTheDocument()`. It
fails on the current build because `isRelayLeg` is `false` and the base map
supplies the em-dash "will retry" tail.

---

## SHOULD-FIX 2 - the one operator ERROR line every close writes reports the ADVISORY envelope attempt, not the durable counter the close decision was made on

**Files:** `app/src/jobs/broadcastFanOut.ts:283`,
`app/src/jobs/relayFanOut.ts:855`. Same shape on the pass-complete INFO lines,
`broadcastFanOut.ts:557` and `relayFanOut.ts:1027`.

The whole point of the branch is that the pass count moved off the envelope and
onto the item, and both files say so in comments ("the envelope's `attempt` is
advisory from M5 on", `broadcastFanOut.ts:574-575`,
`relayFanOut.ts:1047-1048`). But the close's log payload is still:

```
{ broadcastId, deferred, closeCode: code, attempt: payload.attempt, ...err }
```

**Concrete failure scenario.** Close B. `parseBroadcastSendPayload`
(`broadcastFanOut.ts:110-111`) defaults a missing `attempt` to `1`, and close B
is precisely the path a re-drive or a first-pass envelope takes into a spent
ladder. The durable `fanout_attempt` is `3`; the single ERROR line an operator
gets says `closeCode: 'transient_cap', attempt: 1`. An operator investigating
"why did this broadcast give up" reads "attempt 1" beside "gave up after
repeated deferrals" and concludes the log is lying or the cap is misconfigured.
The branch's own test seeds exactly this state
(`app/test/broadcastFanOut.test.ts:474-476`: `fanout_attempt = 3`, envelope with
no `attempt`), and asserts only the line COUNT, never its `attempt` field.

**Fix.** Log the claimed number: `fanoutAttempt: claim?.outcome === 'missing' ? undefined : claim?.attempt`
(or thread the claim into `closeBroadcast`/`closeRelay`), and either drop
`attempt` or rename it `envelopeAttempt` so the two cannot be confused.

**Regression test that would fail.** Extend the close-B cases to read the
captured line: `expect(closeLines(capture)[0]!['fanoutAttempt']).toBe(3)`. There
is no such field today; `closeLines(capture)[0]!['attempt']` is `1`.

---

## SHOULD-FIX 3 - close C turns a transient infrastructure fault into permanent, non-re-sendable recipient failures

**Files:** `app/src/jobs/broadcastFanOut.ts:596-603`,
`app/src/jobs/relayFanOut.ts:1075-1082`.

`enqueue` throwing is treated as proof that "nothing will come back" and every
still-deferred recipient is written TERMINAL `failed / enqueue_failed`, then
(broadcast) the row is finalized. But the causes of that throw are mostly
transient or configuration-level, not per-broadcast:

- no `OutboundQueueAdapter` configured in the worker - the documented
  2026-08-16 prod incident, cited in `app/src/worker.ts:120-123`
  (`jobs.ts:121` throws that exact message);
- `hopCount > MAX_HOP_COUNT` (`jobs.ts:167-170`, `MAX_HOP_COUNT = 10`);
- an SQS `SendMessage` 5xx / throttle / network blip.

**Concrete failure scenario.** A 200-recipient share-broadcast. Twilio
rate-limits, so pass 1 defers 180 recipients (`429`). At the continuation
`enqueue`, SQS returns a 500 for five seconds. Close C marks all 180 recipients
`failed / enqueue_failed` and finalizes the broadcast. Those 180 people were
never sent anything, and there is no bulk way back:
`markSending` is conditional on `status = :draft`
(`app/src/repos/broadcastsRepo.ts:564`), so the broadcast cannot be re-sent; a
manual re-drive of `broadcast.send` finds every slot terminal and no-ops; the
only recovery the product offers is the per-row "open conversation to retry"
link (`dashboard/src/routes/broadcasts/BroadcastResults.tsx:66`) - 180 manual
1:1 sends. The relay twin has no results table at all, so its recovery is
"read the log".

The diff's D9 reasoning is correct about *this envelope* (the job marker does
suppress its redelivery), but the remedy chosen is irreversible while the fault
is not. Worth reconsidering: close the broadcast ROW (so it is not stuck
`sending`) while leaving the deferred slots in a non-terminal, operator-visible
state, or use a distinct terminal code that a re-drive is allowed to re-open.
At minimum the trade-off deserves a line in the issue registry: today
`docs/issues/` records the stuck-sending bug this fixes but not the
permanent-drop it introduces.

---

## Notes

**N1 - the close loop is neither atomic nor resumable, and close B is the first
path that can close a FULL audience.**
`app/src/jobs/broadcastFanOut.ts:268-289`. Every close does, per recipient, a
`setRecipient` + a `bumpStats` + an SSE emit, serially, all AFTER
`putJobExecutionMarker` (`:225`). `MAX_BROADCAST_RECIPIENTS` is 1500
(`broadcastsRepo.ts:67`) and the jobs queue's visibility timeout is 120s
(`infra/modules/jobs/main.tf:36`) with no `ChangeMessageVisibility` heartbeat
anywhere in `app/src`. Any throw mid-loop - or simply running past the
visibility window - leaves a half-closed entity: some recipients `failed`, the
rest `queued`, the row still `sending`, and the redelivery suppressed by the
marker, so nothing can ever finish it. Close A carried this shape before the
branch; close B is new and its `pending` set is the whole audience rather than
`transientRemaining`. (The paced send loop already exceeds 120s on large
audiences, so this is a pre-existing systemic property being amplified, not
introduced.)

**N2 - `finalize` is unconditional, so a second pass can re-finalize.**
`finalize` (`broadcastFanOut.ts:645-679`) is reached whenever `pending` is empty
and calls `audit.append('units#...', 'broadcast_sent', ...)` (`:663`) plus
`flipStatus`, which guards on `attribute_exists(broadcastId)` only
(`broadcastsRepo.ts:459-468`). Two reachable double-runs: (a) a close C whose
`enqueue` actually landed server-side before the client threw - the phantom
continuation arrives, finds every slot terminal, and finalizes again; (b) any
operator re-drive of `broadcast.send` on a finalized broadcast. Result: a
duplicate `broadcast_sent` row on the unit's Activity card, and a
`failed` -> `sent` status flip if the recipient mix changed in between.

**N3 - the new relay close copy is unreachable in the UI for member-originated
traffic.** `closeRelay` writes the `transient_cap` / `enqueue_failed` slots onto
the SOURCE message, which for inbound relay is the member's inbound row. The
dashboard gates both the rollup chip and the per-recipient list on `outbound`
(`Timeline.tsx:911` and `:926`). So slice 5b's operator prose renders only for
TEAM (outbound) relay messages and the broadcast results badge; the relay case
the close was written for - a member's message that could not be fanned out - is
still invisible in the thread. The `closeRelay` docblock notes the hub
`delivery_status` gap (`relayFanOut.ts:833-838`) but not this one.

**N4 - the ladder lengthens the `rail_creating` hold for the one caller that
deliberately cannot ladder.** `app/src/services/groupRail.ts:566-596` and
`:628-640` add up to 2 x ~2s inside the claim. `groupSend`'s inline backstop
(`app/src/services/groupSend.ts:381`, `:425`) is a live staff HTTP request, does
not opt in (correctly, per D16), and is the caller that gets
`another rail creation is already in flight` (`groupRail.ts:444`) while the
claim is held. Net effect: a staff send racing a `groupRail.ensure` job now has
up to ~4s more refusal window than before. Small relative to the Twilio calls
already inside the claim, but it lands on exactly the caller latency was cited
to protect.

**N5 - `reReadUntilBound` returns the LAST list read, not the best seen.**
`groupRail.ts:339-350`. If a later re-read comes back shorter than the one it
replaces, the shorter list is what the repair, the author check and the stored
`twilio_participant_map` are all computed from. Monotonic in practice (Twilio
only adds bindings), so this is a robustness note, not a live defect - but the
function's own docblock claims authoritative-read semantics ("a failed re-read
is a failed read ... never a reason to continue with the stale list"), and
silently accepting a *worse* read is the same class of substitution.

**N6 - tests.** The new suites are unusually strong: `closeLines()` matches by
message so an unrelated ERROR cannot inflate the count; `neverSends()` throws
rather than returning a benign value; the close-A cases drive the real ladder
instead of injecting `attempt: 3`; the "all terminal -> no rung" cases assert
`fanout_attempt` is still `undefined` rather than merely unchanged; and
`broadcastsRepo.integration.test.ts:495-521` proves the counter survives the
wholesale slot write with the right method (`setRecipientDelivery`, explicitly
not `updateRecipientDeliveryStatus`). Three smaller points:

- `dashboard/src/routes/contact/Timeline.email.test.tsx:96` pins the base 30003
  copy on an OUTBOUND EMAIL. An email leg cannot carry a Twilio SMS error code,
  so the guarded position is unreachable; the case will keep passing whatever
  the email path does.
- `app/test/relayFanOut.test.ts:89` adds `delivery_recipients: {}` to the shared
  `seedSource` helper, changing the fixture for every one of the file's ~69
  cases to serve two new ones. Inert here (the job reads
  `snapshot.delivery_recipients?.[key]`) and the suite is green, but it is a
  wide blast radius for a narrow need; a dedicated seed would have been safer.
- `Timeline.delivery.test.tsx:517` is the test that pins SHOULD-FIX 1. It is
  well written; it is asserting the wrong expectation.

---

## Tiers where I found nothing

**Tier 2, the atomic claim itself.** `claimFanoutPass` on both repos
(`broadcastsRepo.ts:650-688`, `messagesRepo.ts:2789-2835`) is correct. The cap
is a `ConditionExpression` (`attribute_not_exists(#fa) OR #fa < :cap`), not a
read-then-write, so two concurrent claims cannot take the same number; the
refusal is disambiguated `capped` vs `missing` by a **strongly consistent**
`GetCommand`, which is the right call because both repos' ordinary getters are
eventually consistent; `UPDATED_NEW` avoids shipping the recipients map; `ADD`
creates the attribute from absent so pre-M5 rows need no migration; and a
non-numeric `Attributes` throws rather than silently claiming. The 8-way
concurrent integration cases (`broadcastsRepo.integration.test.ts:462-490`)
prove exactly 1..8 with no duplicates against real DynamoDB Local. The claim is
placed BELOW the job-execution marker and above any send, and gated on
`pending.length > 0`, so neither a redelivery nor a no-op pass burns a rung -
both asserted.

I walked the following interleavings and found no defect: (a) two SQS
deliveries of the same continuation envelope - suppressed by the per-jobId
marker, which is minted once at enqueue (`jobs.ts:188`) and reused verbatim on
redelivery; (b) a duplicate inbound relay webhook - `routes/webhooks/twilio.ts:692`
gates the fan-out enqueue on `!appended.deduped`, so no second pass with a
fresh jobId exists; (c) a duplicate broadcast send - `markSending` is
conditional on `draft` (`broadcastsRepo.ts:564`) and the route 409s the loser;
(d) a delivery-status webhook racing a close - a slot the close touches is
always one with no provider message (the transient branch's wholesale slot write
drops `conversationId`/`tsMsgId`, so `rollIntoBroadcast` cannot match it), so
no terminal status is overwritten and no stat is double-counted; (e) the
persisted `stats.queued` accounting across all close paths - every terminal
transition decrements it exactly once and `pending`/`transientRemaining` are
disjoint from the already-counted set.

**Tier 3, unintended consequences of the new field.** `fanout_attempt` is a new
top-level scalar on two item types. I checked every writer that could erase it:
`setRecipient` and `setRecipientDelivery` are child-only SETs (proved by the two
new integration cases); `messages.append` writes a fresh item under a new
`tsMsgId`; no `PutCommand` in `messagesRepo.ts` or `broadcastsRepo.ts` rewrites
an existing message/broadcast row wholesale (they are all pointer, marker,
parked-receipt and cross-check items under synthetic partition keys).
`deriveBroadcastStats` iterates the recipients map, not item keys, so the new
attribute cannot leak into a stat. Item-size headroom is ~100KB at the 1500
cap; a scalar is noise. Neither ladder shares the 1:1 `retry_attempt` budget.
The two old close log strings ("... transient retry cap reached ...") have no
consumer outside the branch's own docs - no CloudWatch metric filter, no e2e
assertion, no script. `awaitBindingPropagation` is optional, so no
`GroupRailEnsurer` implementer breaks; both `groupSend` call sites correctly
omit it and both opted-in callers are covered by request-shape assertions
(`groupRailJob.test.ts:76`, `importConvertGroups.test.ts:507`).
`rosterKind` has one production caller that sets `group_text`
(`GroupTextView.tsx:461`); the `'relay'` default is safe on the contact page
because that surface excludes both multi-party types
(`app/src/routes/contacts.ts:1362`).

**Tier 4, security and data integrity - nothing found.** No new write path takes
attacker-influenced input: `claimFanoutPass`'s keys come from internal job
payloads, and its error strings interpolate ids only. The close paths log
`err: cause`, but `serializeLoggedError` (`app/src/lib/logger.ts:190-192`)
allowlists fields for `instanceof Error`, and the redact list already covers the
axios `config.data` case, so a queue error cannot leak the `recipientKeys`
array (which does contain `phone#<E164>` values). The two new dashboard strings
are constants; the `(error <code>)` tail interpolates a provider code into
React text (escaped), and `ownReason` (`deliveryStatus.ts:681-683`) uses
`Object.prototype.hasOwnProperty.call`, so a crafted code cannot reach
`constructor`/`__proto__` on any of the four maps.

**Tier 5, architecture.** The two near-identical closes in two files are the
obvious drift risk, and the branch handled it deliberately rather than
accidentally: they are genuinely different (broadcast has stats, SSE and a
finalize; relay has none of the three), the shared piece that mattered - the
`FanoutClaimResult` union - was extracted into `app/src/repos/fanoutClaim.ts` as
a type-only module rather than duplicated, and both closes share one log message
so a single grep finds both. `cap` as a parameter keeps `repos/` from importing
`jobs/`. `sleep` is a proper injected seam rather than a fake timer. No
misplaced helper found.
