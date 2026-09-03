# Code review R1 - adversarial, plan-blind

Branch `feat/relay-30003-retry-lineage` @ `17bf49a7`, merge base
`f82c149c`. 36 code files, ~7000 added lines. Reviewer was given the diff, the
repo and one sentence of context; no spec, plan, design or issue file for this
branch was opened.

Reproductions were run after the e2e gate marker appeared, in two throwaway
files (`dashboard/src/routes/contact/_review_scratch_quiet.test.ts`,
`app/test/_review_scratch_stranded.test.ts`), both deleted before handback.

Severity counts: BLOCKING 0, HIGH 1, MEDIUM 5, LOW 4, NOTE 5.

---

## 1. HIGH - a crash between the claim and the enqueue strands the whole ladder, silently

**Charter:** 2 (race conditions / crash between two writes).
**Where:** `app/src/routes/webhooks/twilio.ts:2727` (append) and `:2788`
(`enqueueRelayRetryLeg`); the dedupe return at `:2777-2781`.

**The interleaving.**

1. Bob's root leg fails 30003. `handleRelayRecipientStatus`
   (`twilio.ts:2865`) writes the slot, then calls `claimRelayRetry`
   (`:2888`).
2. `messages.append` (`:2727`) commits the retry row AND its
   `sid#relayretry-<digest>-1` pointer in one transaction. **The claim is now
   durable.**
3. The process dies - deploy, SIGTERM, OOM - before `await
   enqueueRelayRetryLeg(...)` at `:2788` reaches the queue. No rung is
   scheduled. No close code is written. No log line is emitted.
4. Twilio redelivers the status callback. Consistent re-read at `:2652`
   succeeds; the slot is still `undelivered`/`30003`, so the gate at
   `:2691-2698` passes; `src.relay_retry_attempt` on the ROOT is still
   undefined, so `:2703-2705` computes attempt 1 again; `:2714-2715` derives the
   **same** `providerSid`.
5. `append` cancels on the SID pointer (`messagesRepo.ts:2390-2413`) and returns
   `{deduped: true}`. `claimRelayRetry` returns at `:2780` -
   **before the enqueue at `:2788`**.
6. No rung 2 is reachable: the only site that claims rung N+1 is a status
   callback resolving through rung N's own `relaysid#` pointer (`:2703`), and
   rung 1 was never sent, so no such callback exists.

**Resulting state:** the retry row sits at `queued` forever, nothing is ever
sent to Bob, the surface reads `Retrying` for 15 minutes and then
`Queued - not confirmed` permanently (finding 3), and the only line about it is
a **WARN** (`isTerminalRelayLegFailure` treats `already_claimed` as non-terminal,
`:401`).

**How proved:** reproduced. `app/test/_review_scratch_stranded.test.ts` drives
the real app through the webhook harness, posts the 30003, drops the queued rung
(`outbound.delayed.length = 0`) to model the crash, and reposts the identical
callback. Passing assertions:

```
expect(scheduledRetryJobs()).toHaveLength(0);
expect(retryRow.delivery_recipients?.[BOB_KEY]).toEqual({ status: 'queued' });
expect(lines(WARN).at(-1)).toMatchObject({ retryClaim: 'already_claimed' });
```

Note the asymmetry: D8's neighbouring window (a crash between the slot write and
the claim) was deliberately made recoverable - `:2682-2690` says so at length.
The window one `await` later was not.

**Smallest fix:** make the rung durable in the same transaction as the claim.
`NewMessage.dueRow` (`messagesRepo.ts:2340-2354`) already exists for exactly
this - native group text writes a deadline row inside the append transaction
because "a post-append enqueue would leave a crash window in which a send exists
with nothing watching its receipts". Write the rung the same way and let the due
sweeper dispatch it. Do **not** fix it by re-enqueueing on `already_claimed`:
`sendOneRelayLeg` skips only a *terminal* slot, so a rung merely delayed in the
queue would be sent twice.

A regression test fails with the fix reverted: the scratch file above asserts
`scheduledRetryJobs()` (or, post-fix, the presence of a due row) is non-empty
after the redelivery; today it is empty.

---

## 2. MEDIUM - normal operator actions log at ERROR and feed the paging alarms

**Charter:** 1 (error handling that mis-attributes) + 4 (alarms fed by ERROR logs).
**Where:** `app/src/jobs/relayRetryLeg.ts:354`, `:377`, `:398`, `:406` - all four
D9 gate refusals are `log.error`.

The module that owns the taxonomy says the opposite rule two files over:
`twilio.ts:322` defines `EXPECTED_NONFAILURE_DELIVERY_CODES = new Set(['21610'])`
precisely so a provider-side opt-out stays WARN - "correctly honoring STOP - the
platform working, not a failure". A member who sends STOP between the 30003 and
the rung is the **same event**, and `relayRetryLeg.ts:405-410` logs it at ERROR
with `closeCode: 'retry_opted_out'`. The same holds for an operator closing the
group (`retry_group_closed`) or removing a member (`retry_member_removed`):
deliberate human actions, each producing an alarm-feeding ERROR per pending
retry leg.

The alarm is not merely a dashboard: `infra/modules/observability/main.tf:186-200`
defines `error-logs-sustained` at **threshold 1** across **3 consecutive**
5-minute buckets - a single error in each of three buckets pages.

**How proved:** walked. `isTerminalRelayLegFailure` (`twilio.ts:395-402`) is not
involved here at all - these are the job's own `log.error` calls, so no carve-out
applies to them.

**Smallest fix:** log the four `gate_refused` closes at WARN (they are refusals
by design, and the close code is already durable on the slot for the UI to read);
keep ERROR for `cap_exhausted`, `enqueue_failed` and `source_unreadable`, which
are the genuine dead ends.

---

## 3. MEDIUM - a quiet or stranded rung erases the carrier's 30003 from every position

**Charter:** 4 (unintended consequences in a shared presenter).
**Where:** `dashboard/src/routes/contact/relayRetryJoin.ts:365-368`
(`withDecidingRung` overlaid on the quiet rung, clearing `errorCode`) and
`dashboard/src/routes/contact/deliveryStatus.ts` (`notConfirmed` union;
`{ label: composed, tone: 'danger', isFailure: false }`).

**The state.** Bob's root leg is `undelivered`/`30003`. A rung is claimed and
strands (finding 1) or its receipt never arrives. Past `STALE_SENT_AFTER_MS`
(`deliveryStatus.ts:64`, 15 min) the rung stops being live, `projectOneLeg`
step 3 overlays the rung's own `queued` status onto the original slot and drops
`errorCode`, and the leg lands in J (`not confirmed`) rather than K (`failed`).

Before this branch that same leg read
`delivered 0/1 - 1 failed` + reason `Phone unreachable (error 30003)` and
`isFailure: true`. It now reads `delivered 0/1 - 1 not confirmed`,
`isFailure: false`, and **carries no reason at all** - so the carrier code an
operator needs is gone from the chip, the accessible-name recital and the row,
permanently (no further rung will ever be claimed).

**How proved:** reproduced.
`dashboard/src/routes/contact/_review_scratch_quiet.test.ts`, passing:

```
expect(chip).toEqual({ label: 'delivered 0/1 - 1 not confirmed', tone: 'danger', isFailure: false });
expect(JSON.stringify(chip)).not.toContain('30003');
expect(row).toEqual({ label: 'Queued - not confirmed', tone: 'danger', isFailure: false });
```

**Smallest fix:** in `projectOneLeg` step 3, when the quiet rung never left
`queued` (no parseable `sentAt`), nothing was sent on the retry, so the leg is
still definitively failed: keep the ORIGINAL's `status` and `errorCode` and let
`retryState: 'unconfirmed'` qualify the label. Failing that, at minimum carry the
original's code through as the presentation's `reason` so the chip still names
the carrier failure.

---

## 4. MEDIUM - the backoff-injection seam is dead in every deployed environment, and its docblock says the opposite

**Charter:** 1 (dead/unreachable code, misleading comments) + 3 (env-var seams).
**Where:** `app/src/jobs/relayRetryLeg.ts:124-156` (`registeredBackoffMs`),
`app/src/jobs/registerHandlers.ts:56-70` (`E2E_RELAY_RETRY_BACKOFF_MS`),
`app/src/index.ts:42`.

**The walk.**

- `enqueueRelayRetryLeg` has exactly one caller: `twilio.ts:2788`, in the **app**
  process (the status webhook). All three rungs come from there - the job's own
  re-enqueue (`relayRetryLeg.ts:478`) uses `transientBackoff`, not `backoffMs`.
- `app/src/index.ts:42` gates `registerAllJobHandlers` on
  `if (!config.jobsQueueUrl)`, with the comment "Production never registers
  handlers in the app".
- Therefore in any deployed environment `registeredBackoffMs` is `undefined` in
  the process that reads it, and `relayRetryBackoffMs` (60/120/240) is used. The
  worker's copy is set and never read.

The result is correct **by accident** (the fallback equals production's value),
but the docblock's stated hazard - "the lane override would shorten rungs 2-3
while rung 1 still waited 60s" - is not reachable, because the same webhook
enqueues all three rungs. The latent trap is real: any future non-e2e backoff
supplied through `registerRelayRetryLegJobHandler({ backoffMs })` would be
silently ignored in production while appearing to work locally.

Corollary that *reduces* a security concern: `E2E_RELAY_RETRY_BACKOFF_MS` set in
a deployed environment has **no effect on the ladder** for the same reason. It is
still the first `E2E_*` variable in this repo read from always-mounted production
code (the others live in `app/src/routes/dev.ts`, which AGENTS.md describes as
structurally absent in deployed envs).

**Smallest fix:** correct the docblock, and either read the override directly
inside `enqueueRelayRetryLeg` (one process, one place) or state plainly that the
registration store only works in the in-process topology.

---

## 5. MEDIUM - the destination digest is a reversible phone number, in a sort key, in logs, and in a URL

**Charter:** 3 (PII in logs or sort keys).
**Where:** `app/src/lib/relayRetryClaim.ts:25-30`.

```
createHash('sha256').update(`${rootTsMsgId}|${destinationE164}`).digest('hex').slice(0, 16)
```

The docblock immediately above (`:20-24`) states the property being protected:
"Hashed, never raw: this value ends up inside a sort key, where a phone number
must never appear."

The hash is unkeyed and the salt is public. `rootTsMsgId` travels beside the
digest everywhere the digest goes:

- the sort key `<providerTs>#relayretry-<digest>-<n>` and the `sid#` partition key;
- log lines - `relayRetryLeg.ts:253-258` puts `retryTsMsgId` in `base` (every
  line the job writes) and `:286` adds `rootTsMsgId` to `ladder`;
  `twilio.ts:2809-2810` logs both;
- a URL path: a delivered retry row with media renders
  `/api/messages/relayretry-<digest>-<n>/media/:idx`
  (`Timeline.tsx:713` -> `api.ts:2334`), which reaches access logs and browser
  history.

A NANP handset is a ~2^33 search space; recovering the pre-image of a 64-bit
truncated SHA-256 over it is under a second on a commodity GPU. The stated
invariant is therefore only nominally satisfied.

**How proved:** walked; the inputs and the output width are both literal in the
five lines above.

**Smallest fix:** `createHmac('sha256', <a secret already on AppConfig>)` instead
of `createHash`. Both the webhook and the job load config, so determinism across
the two is preserved.

---

## 6. MEDIUM - the e2e's one real assertion lives inside a 3-second window

**Charter:** 5 (timing budgets a slower machine breaks).
**Where:** `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:203-230`;
`scripts/e2e-session.mjs:254` sets `E2E_RELAY_RETRY_BACKOFF_MS: '3000'`.

Assert 1 - the D16 claim-time SSE, described in the file's own header as "the
point of D16" - polls for `1 retrying`. That string exists only between the
claim's SSE and the rung landing, i.e. **3000 ms minus the SSE round trip and
the thread refetch**. Once the retry lands the chip reads
`delivered 2/2 - 1 on retry` and never reads `1 retrying` again, so a missed
window is not a slow pass - the poll burns its full 30 s and the test fails. The
250 ms interval buys sampling density inside the window; it cannot widen it.
`test.slow()` extends the test timeout, not the window.

**How proved:** walked. The window is `E2E_RELAY_RETRY_BACKOFF_MS`; nothing in
the spec waits for the SSE to be applied before the window opens.

**Smallest fix:** raise `E2E_RELAY_RETRY_BACKOFF_MS` to ~10000. It costs the
suite seven seconds and makes the observation window an order of magnitude
larger than the render latency it is racing.

---

## 7. LOW - a suppressed retry leg can stamp `contact_opted_out`, which deletes the whole chip

**Charter:** 4 (shared presenter) + 2 (race).
**Where:** `app/src/jobs/relayRetryLeg.ts:404` (gate) and
`app/src/jobs/relayFanOut.ts:1284-1317` (`sendOneRelayLeg`'s `suppressed` arm).

`RelayRetryCloseCode`'s docblock (`relayRetryLeg.ts:86-89`) is explicit:
"`contact_opted_out` is deliberately NOT in this set: the dashboard drops that
code from the relay rollup entirely." But the gate at `:404` and
`sendOneRelayLeg` ask `isMemberSuppressed` **twice**, and if the answer flips
between the two reads the extracted unit writes `contact_opted_out` onto the
retry row's slot - a code the retry path is documented never to produce.

Downstream: `projectOneLeg` step 4 copies the last rung's close code onto the
ORIGINAL leg, and `presentRelayDelivery`'s
`fanned = included.filter(s => s.errorCode !== 'contact_opted_out')` then drops
that leg from the denominator. On a one-member relay group the rollup returns
`null` - **no chip at all** - and the row reads "Not sent - opted out" for a leg
that was sent and rejected by the carrier.

**How proved:** reproduced (the projection half).
`_review_scratch_quiet.test.ts`, second case, passing:

```
expect(presentRelayDelivery([leg], { relay: true, retryAware: true, nowMs })).toBeNull();
expect(presentLegDelivery(leg, 'relay', undefined, nowMs)).toMatchObject({ label: 'Not sent - opted out' });
```

The race that produces the code is millisecond-wide, hence LOW.

**Smallest fix:** drop the duplicate check - pass the gate's answer into
`sendOneRelayLeg`, or map a `suppressed` outcome on the retry path onto
`retry_opted_out` before it reaches the slot.

---

## 8. LOW - two stored lineage fields cross the wire despite three docblocks saying they do not

**Charter:** 1 (misleading comments) + 3.
**Where:** `dashboard/src/api/types.ts` (both new blocks) and
`dashboard/src/routes/conversation/useRelayThread.ts:126-131`, versus
`app/src/routes/api.ts:2173` / `:2191`.

The comments say `relay_retry_dest_digest` and `relay_retry_leg_body` "are
stored server-side and deliberately do NOT cross the wire". `GET
/api/conversations/:conversationId/messages` returns `{ messages: page }` - the
stored rows as-is - so both fields reach every authenticated browser on every
relay thread load. They are merely undeclared in the TypeScript interface, which
is not a transport boundary. Combined with finding 5, the digest and its salt
arrive in the same JSON object.

**How proved:** walked (`api.ts:2148-2199` has no projection step; only
`relay_external_caller_display_name` is added).

**Smallest fix:** either project the row explicitly in that handler or delete the
claim from all three docblocks.

---

## 9. LOW - the harness fake's media index contradicts the real repo for retry rows

**Charter:** 5 (fakes that no longer mirror the real repo).
**Where:** `app/test/helpers/twilioWebhookHarness.ts:1350-1373` versus
`app/src/repos/messagesRepo.ts:2371` and `:2909-2922`.

The diff's `!isRelayRetryRow` guard stops `append` writing media-pointer rows for
a retry row. The fake has no pointer rows: `listMediaPointers` *derives* the
index from stored messages, so in the fake a retry row carrying
`media_attachments` **does** appear in the gallery index. Any future assertion
written through the fake gets the opposite answer from production. (The real
behaviour is covered against real DynamoDB by
`app/test/messagesRepoRetryLineage.integration.test.ts:110`, so nothing is broken
today.)

**Smallest fix:** skip rows carrying `relay_retry_of` in the fake's derivation,
with a one-line comment pointing at the real guard.

---

## 10. LOW - rung 1's leg copy is reconstructed from the current roster, not from what was sent

**Charter:** 1 (contracts split across modules that can disagree).
**Where:** `app/src/routes/webhooks/twilio.ts:547-570` (`composeRelayLegCopy`),
`app/src/jobs/relayFanOut.ts:194-197` (`composeRelayBody`).

D12's verbatim guarantee starts at rung 2 (`twilio.ts:2721-2726` reads the
stored copy). Rung 1's copy is composed at CLAIM time from a fresh
`conversations.getById`. If the sender was renamed - or removed from the roster -
between the fan-out send and the 30003 callback, `roster.find(...)?.name` yields
`undefined` and `composeRelayBody` falls back to `A member: <body>`. The retry
then resends a differently-attributed message than the one that failed, which is
the exact class of drift D12 exists to prevent.

**How proved:** walked. The window is seconds, hence LOW.

**Smallest fix:** compose and store the leg copy where it is actually sent
(`sendOneRelayLeg`, which already receives `legBody`), so the claim reads a
stored value on every rung including the first.

---

## 11. NOTE - an unclassified send error loses the rung with no close code

`sendOneRelayLeg` still throws for an error that is neither a refusal, nor
30007, nor transient (`relayFanOut.ts:1407`). In the fan-out, SQS redelivery
re-runs the whole job; in the retry job the execution marker is written FIRST
(`relayRetryLeg.ts:264-273`), so the redelivery no-ops and the rung is lost with
the slot left at `queued`/`attempted` and no close code. The UI then degrades via
finding 3's path. Bounded by a thrown-and-logged job error, so at least visible.

## 12. NOTE - the retry's activity bump reorders the inbox with a stale preview and no SSE

`relayRetryLeg.ts:440-444` calls `touchLastActivityPreservingStatus(id,
undefined, now)`. The relay row's preview comes from the STORED
`last_message_preview` (`inbox.ts:1211`), which is untouched, so an active thread
jumps to the top of the inbox showing a preview that may be several messages old.
No `conversation.updated` is emitted either, so the reorder only appears on the
next poll. Both are consequences of D16's ordering-only intent; naming them so
the next reader does not treat them as bugs.

## 13. NOTE - the severity change multiplies per message

One permanently unreachable handset in an active relay group now produces one
`cap_exhausted` ERROR per relayed message, ~7 minutes after each send
(`twilio.ts:2926`). Previously every relay 30003 was WARN. With
`error-logs-sustained` at threshold 1 over 3 consecutive 5-minute buckets, a
group receiving a message every few minutes will page on a single dead number.
This is arguably the intended honesty (30003 now behaves like every other
terminal code), but the volume is worth confirming before it reaches prod.

## 14. NOTE - one contact on two handsets mints two ladders, one of which always dies as "number changed"

`relayMemberKey` collapses two roster entries sharing a `contactId` into one
slot, while the ladder identity is the destination (`relayRetryClaim.ts:25`). Two
legs failing 30003 therefore mint two rung-1 rows under one member key; the job's
`roster.find(...)` (`relayRetryLeg.ts:374`) returns whichever entry is first, so
the other ladder refuses at the digest gate (`:395`) with `retry_number_changed`
- copy that reads "number changed since", which is not what happened. The code
comments acknowledge the collapse and a `docs/issues/relay-member-key-*` file
exists, so this is recorded rather than raised.

## 15. NOTE - deliveryStatus.ts's docblocks over-claim the shared consumers

Several new comments justify `retryAware`'s default by "the shared `Delivered
N/N` label - also serving native group text and the broadcasts routes". The
broadcasts routes import only `presentDeliveryStatus`
(`broadcasts/broadcastFormat.ts:13`) and `deliveryReason`
(`broadcasts/DeliveryBadge.tsx:7`); the only other consumer of
`presentRelayDelivery` / `presentLegDelivery` is the same `Timeline` rendered
with `rosterKind='group_text'`. The gating is right; the stated reason is wider
than the truth, which matters the next time someone weighs a change to that
label.

---

## Swept clean

Consumers and mutators checked that behave correctly - do not re-audit these.

- `app/src/routes/inbox.ts:1211` `relayRowFor` - reads the STORED
  `last_message_preview`, not the newest message, so a retry row cannot displace
  a relay thread's inbox preview. (`latestMessageOf` is contact/unknown rows only.)
- `app/src/lib/unreadFeed.ts:575` - the newest-message probe is gated by
  `isOneToOneBucket`; relay threads take the group-row path. Unaffected.
- `app/src/routes/contactTimeline.ts:1232` - excludes `relay_group` and
  `group_text` by name, so retry rows never enter the 1:1 merged timeline.
- `app/src/routes/contacts.ts:1374-1379` - the media gallery excludes multi-party
  threads by name; the suppressed media pointers have no reader today.
- `app/src/routes/api.ts:2334` `/messages/:providerSid/media/:idx` - resolves via
  the `sid#` pointer the claim writes, so a delivered retry bubble's attachments
  still serve despite the pointer-row suppression.
- `app/src/services/relayQueuedMessages.ts:64` - the flush selects
  `delivery_status === 'queued_pending'`; a retry row is `queued`. Not picked up.
- `app/src/jobs/relayFanOut.ts:772-780` - the 5-row source window is bounded by
  `before: bumpKey(sourceTsMsgId)`, and a retry row's wall-clock `providerTs`
  sorts strictly after the root, so it cannot displace the source.
- `app/src/jobs/extraction.ts:456` - transcript window; relay retry rows would
  duplicate a body, but extraction is not driven for relay conversations.
- `app/src/jobs/relayFanOut.ts:1123-1145` - the `sendOneRelayLeg` extraction is
  faithful: same order, same writes, same throw; the two loop-local counters are
  rebuilt from `outcome.kind` and nothing else moved.
- `app/src/repos/messagesRepo.ts:911-960` `assertTransportPersistenceShape` - a
  versioned retry row with no message-level `requestedTransport` is legal; the
  inbound prohibition is on the message field only, and the slot's value is
  permitted.
- `dashboard/src/lib/messageTransport.ts:125` `presentMessageTransport` - an
  outbound versioned retry row with recipients present takes the recipient
  aggregate, so the missing message-level `requested_transport` does not surface
  as "Unknown".
- `dashboard/src/routes/contact/Timeline.tsx:968,1017` - `projectRelayLegs` and
  `retryAware` are gated on `rosterKind === 'relay'`, so native group text's
  slots are not even copied. `retryIndex` is computed for every host but is empty
  for a thread with no retry rows.
- `dashboard/src/routes/contact/Timeline.tsx:1313` - the Retry button reads the
  MESSAGE's `delivery_status`, which a relay source never sets to failed, so
  finding 3 removes no operator affordance that existed.
- `dashboard/src/routes/contact/deliveryStatus.ts` K/R/J disjointness - K
  requires `terminal`-or-none, R requires `retrying`, J's second arm excludes
  both live states and `isStaleLeg` is already false for terminal statuses. The
  composed label's addition is sound.
- `dashboard/src/routes/conversation/useGroupThread.ts:27` - shares
  `buildRelayItems`, so the D20 filter runs for native group text too; inert
  there (no row carries `relay_retry_of`).
- `app/src/repos/messagesRepo.ts:3196-3208` - `planned -> excluded` is a legal
  aggregation transition, so `refuseGate` succeeds on a freshly seeded versioned
  retry slot; on a second transient pass the state is `attempted`, which
  `setVersionedAggregationState`'s acceptable-state readback tolerates.
- `app/src/repos/messagesRepo.ts:128-138` `ALLOWED_PRIOR` - `delivered` cannot
  follow `undelivered`, so a late delivered callback cannot flip a root leg out
  from under a running ladder.
- `app/src/repos/messagesRepo.ts:3463-3507` `claimFanoutPass` on the retry row -
  the transient sub-ladder is 3 passes with 5s/10s backoff, matching the
  fan-out's documented shape; `claim.outcome !== 'claimed'` catches the
  attribute-less `missing` result before `claim.attempt` is read.
- `app/src/lib/events.ts` / `app/src/routes/api.ts:2538` - the claim's extra
  `message.persisted` is forwarded to SSE only; no push notification is driven
  by that event, so the claim cannot spam devices.
- `docs/issues/quiet-hours-ungated-automated-paths.md` - the new automated send
  path is recorded there with its bound; the omission is deliberate and
  inherited, not new.
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:7` - `deliveryReason` gained
  four `retry_*` codes; a broadcast recipient can never carry one, so the badge
  is unchanged.
- `app/test/twilioStatusWebhook.test.ts` new `describe` - the 1:1 fence case
  asserts `retryClaim` is absent and `relay` is undefined, so the fenced path is
  pinned, not assumed. Would fail if the relay branch's severity leaked.

---

## Questions for the author

1. Finding 2: was ERROR for the four gate refusals a deliberate decision against
   21610's precedent, or an unexamined default? A group the operator closed is
   not a fault.
2. Finding 3: when a stranded rung never left `queued`, nothing was sent - is
   softening a known 30003 to "not confirmed" the intended reading, or should the
   original's status and code survive when the deciding rung has no `sentAt`?
3. Finding 4: was the app process's `if (!config.jobsQueueUrl)` registration gate
   known when `registeredBackoffMs` was designed? The docblock reads as though
   both processes register.
4. Finding 5: is there an existing per-environment secret on `AppConfig` the
   digest could be HMAC'd with, or does that need a new value?
5. Finding 13: has the founder seen the per-message ERROR volume for a group with
   one permanently dead handset, as opposed to the per-leg taxonomy in isolation?
