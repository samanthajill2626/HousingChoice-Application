# Code review R2 - re-review after fix wave 1

Branch `feat/relay-30003-retry-lineage` @ `b971618e`, merge base `f82c149c`,
fix wave `17bf49a7..b971618e`. Fresh reviewer: wrote neither R1 file nor the
fixes.

Read in order: `code-review-r1-adjudications.md`, both R1 findings files,
`fix-wave-1-report.md`, `.superpowers/review/fix-wave-1-diff-package.md`, the
whole-feature code diff, the design spec (D1-D23, Sec 7, Sec 9) and
`research-adjudications.md`, then the live tree.

Method note. Two throwaway suites were written, run and DELETED
(`app/test/_review_scratch_slotmissing.test.ts`,
`app/test/_review_scratch_f7.test.ts`); their output is quoted below. Four
dashboard Timeline suites were run unmodified at HEAD (231 passed). No tracked
file was edited; no commit was made; `git status` carries only this file.

Counts: **Section 1** HIGH 1 / MEDIUM 2 / LOW 1 / NOTE 2.
**Section 2** MEDIUM 4 / LOW 2 / NOTE 4.

---

## 1. NEW findings the first pass missed

### 1.1 HIGH - the stranded-claim state is invisible at EVERY layer at once

- **Where:** `app/src/routes/webhooks/twilio.ts:2792-2796` (the dedupe return
  before the enqueue); `dashboard/src/routes/contact/relayRetryJoin.ts:365-368`
  (the `unconfirmed` overlay clears `errorCode`);
  `dashboard/src/routes/contact/deliveryStatus.ts:485-497` and `:531-537` (the
  `retrying || notConfirmed` chip returns no `reason`);
  `dashboard/src/routes/contact/Timeline.tsx:1313` (the Retry button reads
  `delivery.isFailure`).
- **Why the first pass missed it:** each half was seen and each half was
  individually dispositioned - A1 -> FILE (`F11`), A3 -> OPEN (`Q2`), the Retry
  button -> "swept clean, removes no affordance that existed". Nobody composed
  them.
- **The composed failure:** the process dies between the claim's `append` and
  `enqueueRelayRetryLeg`. Then, in one state: (a) the only log line is a **WARN**
  carrying `retryClaim: 'already_claimed'`, so no alarm fires anywhere - and F1
  has just made the neighbouring `slot_ineligible` WARN too, so the whole
  "no ladder is running" family is now un-alarmed; (b) the chip, the recital and
  the row all read `not confirmed` with **no carrier code at any position**,
  because `withDecidingRung` clears `errorCode` and the chip's only `reason`
  channel is the `failed > 0` branch; (c) `isFailure` is deliberately false, so
  no Retry action is offered; and (d) the relay source's own
  `delivery_status` is never `failed`, so the message-level Retry never appears
  either. A member never receives a relayed message and there is no signal - in
  logs, on screen, or as an affordance - that anything is wrong.
- **How proved:** walked, on top of the adversarial review's own reproduction of
  (b) and its issue `docs/issues/relay-retry-stranded-claim-window.md`.
- **Minimum:** the reconciliation sweep stays out of scope (that adjudication is
  upheld), but ONE of these belongs on the branch: log the
  claim-durable-but-unenqueued case at ERROR, or carry the original's carrier
  code into the `unconfirmed` presentation (see 3.5 - the presentation already
  has a `reason` channel for exactly this).

### 1.2 MEDIUM - the `DeliveryFailures` paging alarm now counts up to 4x per message

- **Where:** `infra/modules/observability/main.tf:95` (the metric filter
  `{ $.event = "delivery_failed" }`) and `:238-256` (the alarm: Sum, period 300,
  `evaluation_periods = 1`, threshold `var.delivery_failures_threshold`);
  `app/src/routes/webhooks/twilio.ts:2947-2974` (the marker);
  `app/src/jobs/relayFanOut.ts:1423-1427` (`putRelaySidPointer` on the rung).
- **The failure:** every rung's own provider SID gets a `relaysid#` pointer, so
  each rung's failed callback re-enters `handleRelayRecipientStatus` and emits
  another `event: 'delivery_failed'`. One permanently dead handset in a relay
  group now produces FOUR such events per relayed message (root + 3 rungs) where
  main produced one, with root/rung1/rung2 landing inside about three minutes -
  i.e. usually the same 5-minute bucket. `hc-<env>-delivery-failures` is a raw
  COUNT alarm over one period, so its effective threshold has been divided by
  roughly four for relay traffic. The branch's own comment at `twilio.ts:2941-2946`
  says "the DeliveryFailures count metric ... is unaffected" - true of the
  SEVERITY change it is attached to, and false of the feature.
- **How proved:** walked. The repo states the mechanism itself: the severity
  suite's helper exists "so the cap case is reached without walking a whole
  ladder" (`app/test/twilioStatusWebhook.test.ts:1176-1181`), i.e. a rung's own
  callback re-enters the relay branch.
- **Note:** Q4 (A13) counted only the `cap_exhausted` ERROR line per message. It
  did not count this metric, and this alarm pages on a single period rather than
  three consecutive ones.

### 1.3 MEDIUM - `Retrying`'s reason is derived with different options from every other position

- **Where:** `dashboard/src/routes/contact/deliveryStatus.ts:679`
  (`deliveryReason(slot.errorCode, { relay: true })`) versus
  `Timeline.tsx:602-612` and `:1253-1259`, which call
  `deliveryReason(code, { media, relay })`.
- **The failure:** the `retrying` presentation bakes its reason in with
  `media` hard-coded absent. `deliveryReason`'s own docblock
  (`deliveryStatus.ts:895-905`) says the map order "is LOAD-BEARING, and it is
  pinned by a test because nothing observable depends on it today", precisely
  because the media and relay maps are disjoint TODAY. The moment a media
  override is added for 30003 - the case that comment is written about - an MMS
  relay leg will read the media hedge at the row, the recital and the chip and
  the plain relay copy at `Retrying`, on the same leg. The branch adds the second
  derivation the comment was warning about.
- **How proved:** walked (the two call sites are literal).
- **Minimum:** pass the caller's `DeliveryReasonOptions` into `presentLegDelivery`
  rather than reconstructing `{ relay: true }` inside it, or drop the baked-in
  reason and let the `leg?.reason ?? ...` fallback own it.

### 1.4 LOW - Q3 and F8 compound: the digest AND its salt are a browser payload

- **Where:** `app/src/lib/relayRetryClaim.ts:25-30` (unkeyed truncated SHA-256
  over `rootTsMsgId|E164`); `app/src/routes/api.ts:2160-2174` (the messages
  endpoint returns stored rows as-is, confirmed - the only hydration is
  `relay_external_caller_display_name`).
- **The failure:** `relay_retry_dest_digest` and `relay_retry_of` (which IS the
  salt) arrive in the same JSON object on every relay thread load. Q3 was left
  as specified and F8 was resolved by CORRECTING THE COMMENT rather than
  projecting the row, so the two adjudications together leave the exposure
  strictly where the adversarial review found it, now documented as intended.
  The spec's "no phone number in a sort key" is met nominally; the handset is
  recoverable client-side from data the client is handed.
- **How proved:** walked, plus the endpoint read above.
- Practical severity is bounded (viewers are authenticated staff who can already
  see the roster), which is why this is LOW - but the pair should be decided
  together, not as two independent items.

### 1.5 NOTE - the ticker's retry clause is not roster-gated while the projection is

`Timeline.tsx:869-874` consults `retryIndex` for every host, including
`rosterKind === 'group_text'`; the projection at `:1017-1027` is gated on
`isRelayLeg`. Inert today (nothing outside a relay conversation carries
`relay_retry_of`), but the two halves of D18 are gated differently, so a future
row shape that leaked the field would arm an interval that can change no pixel.

### 1.6 NOTE - a stale line citation propagated through three files

The F7 comment (`app/src/jobs/relayRetryLeg.ts:571`), the fix-wave report and the
adjudication all cite `deliveryStatus.ts:408` for the `contact_opted_out`
denominator filter. That filter is at `deliveryStatus.ts:449`; line 408 is inside
a docblock. Cheap to fix, and the repo's whole citation convention rests on these
being right.

### Swept with NO finding (do not re-audit)

- **The main merge `2af362e2`.** `dashboard/src/routes/contact/Timeline.tsx` is
  the ONLY file both sides touched (`git merge-base 645f509c f82c149c` =
  `bb54fdaa`; the intersection of the two diffs is that one path). Both sides'
  hunks survive: main's `LinkifiedText` at `Timeline.tsx:25`, `:1168`, `:1647`,
  `:1656`, and the branch's projection/ticker/D20 filter. Ran unmodified at HEAD:
  `Timeline.test.tsx` 155, `Timeline.delivery.test.tsx` 35,
  `Timeline.ticker.test.tsx` 32, `Timeline.linkified.test.tsx` 9 - **231 passed**.
  A delivered retry bubble renders its RAW body through the same linkifier, which
  is the wanted behaviour.
- **The harness fake versus the real repo, for every method the branch added or
  changed.** `append`'s six lineage fields
  (`app/test/helpers/twilioWebhookHarness.ts:1136-1152` vs
  `app/src/repos/messagesRepo.ts:2220-2233`), the SID-pointer dedupe returning
  the PERSISTED tsMsgId (`:1085-1087` vs `:2360-2372`),
  `getByTsMsgIdConsistent` (`:1327-1330`, correctly the same lookup - an array
  has no eventual consistency to model), `touchLastActivityPreservingStatus`
  (`:543-560`, never writes `status`, deliberately not recorded in `touches`),
  and `applyRecipientSendResult`'s terminal-code preservation, which I exercised
  directly (see 2.2) and found value-identical to
  `app/src/repos/messagesRepo.ts:3402-3417`. F9 closed the last divergence.
- **`composeRelayLegCopy` and the TEAM sender** (`twilio.ts:562-582`). A10 is
  genuinely only a rename race: the claim maps `TEAM_SENDER_KEY` to
  `TEAM_SENDER_LABEL`, and that label is the only value any caller ever passes as
  `senderNameOverride` (`app/src/routes/api.ts:1835`,
  `app/src/services/relayQueuedMessages.ts:97`). A team-originated retry does NOT
  drift to "A member:".
- **The group-text fence in the presenter.** `presentLegDelivery` is the only
  per-leg presentation that can carry a `reason`, and it does so exclusively
  inside `if (rosterKind === 'relay')` (`deliveryStatus.ts:672-701`), so the new
  `leg?.reason ?? ...` precedence at `Timeline.tsx:602-612` and `:1253-1259` is
  inert for native group text.

---

## 2. Findings IN the fix diff (`17bf49a7..b971618e`)

### 2.1 MEDIUM - F1's whitelist is four times wider than the adjudication that justified it

- **Where:** `app/src/routes/webhooks/twilio.ts:411-416` (the WARN arm) against
  the four producers of the outcome: `:2707` (slot ABSENT), `:2708-2710`
  (any non-failure status, `queued`/`sent`/`delivered`), `:2711-2713` (a different
  terminal code).
- **Contract:** the founder-approved set is "every fan-out or team leg that ends
  terminally on 30003 ... or was never claimed at all because `To` was missing or
  the source row could not be read" (spec Sec 6 / D23). The R1 conformance
  finding argued WARN for exactly two of the four - `delivered` and 30007 - and
  its own "smallest fix" offered "split the outcome, or **add that one status
  test** inside `isTerminalRelayLegFailure`". The fix wave whitelisted the whole
  outcome value instead.
- **The failure:** an ABSENT member slot is an internal anomaly of exactly the
  `source_unreadable` class - the repo treats it as a real, expected-enough state
  to log for (`messagesRepo.ts:3544-3550`, "recipient delivery status for unknown
  recipient slot ignored") - and the leg DID end terminally on 30003 with no
  ladder running. It is now WARN. So is a leg whose slot write was refused and
  still reads `sent`. Both are false NEGATIVES on a brand-new alarm, and both
  take the generic carrier-shaped message, so an operator reading the WARN gets
  no hint either.
- **How proved:** reproduced. Throwaway suite, both cases passing:

```
expect(lines(capture, WARN)).toContainEqual(objectContaining({ retryClaim: 'slot_ineligible' }));
expect(lines(capture, ERROR)).toHaveLength(0);
```

  Case 1 seeded `deliveryRecipients: {}` with the `relaysid#` pointer present;
  case 2 seeded `{status:'sent'}` and stubbed `updateRecipientDeliveryStatus` to
  return false (its own refusal path). Both logged WARN, zero relay ERRORs.
- **Minimum:** narrow the predicate to the two adjudicated shapes - e.g. keep the
  WARN only when the slot exists and its status is `delivered` or its `errorCode`
  is another terminal code - and add the missing SEV case for the absent slot.

### 2.2 MEDIUM - F7 is INERT on the shape every relay source now takes, and its ERROR line says otherwise

- **Where:** `app/src/jobs/relayRetryLeg.ts:581` (the re-stamp) and `:588-591`
  (the unconditional `closeCode`); the no-op is
  `app/src/repos/messagesRepo.ts:3407-3413` (`terminalCurrent && statusSame`
  refuses the overwrite).
- **The inverted premise:** the fix-wave report calls the versioned case a
  "bound" because "every relay source written before 2026-09-02 is legacy". That
  is backwards for the live population. Every relay source appended TODAY is
  versioned - member-originated at `app/src/routes/webhooks/twilio.ts:840` and
  team-originated at `app/src/routes/api.ts:1816` both stamp
  `transportSchemaVersion` unconditionally - and the claim mirrors that onto the
  retry row (`twilio.ts:2732`, `:2762`). A ladder runs seconds-to-minutes after
  the send, so the source it retries is essentially always one of those. F7
  therefore lands on the shape that is being retired and misses the one in use.
- **The failure:** the slot keeps `contact_opted_out`; `projectOneLeg` step 4
  copies that code onto the ORIGINAL leg
  (`relayRetryJoin.ts:374-380`); `presentRelayDelivery` filters it out of the
  denominator (`deliveryStatus.ts:449`); on a one-member relay group the rollup
  returns `null` - **no chip at all** - and the row reads "Not sent - opted out"
  for a leg that was sent. That is A7, unchanged. Separately, the ERROR line
  reports `closeCode: 'retry_opted_out'` on a path where the job wrote nothing
  durable, which breaks the file's own stated contract that "`closeCode` appears
  where the JOB wrote one".
- **How proved:** reproduced end to end. Throwaway suite mocking
  `isMemberSuppressed` so call 1 (the D9 gate) answers false and call 2 (inside
  the REAL `sendOneRelayLeg`) answers true - the exact flip F7 exists for:

```
VERSIONED SLOT {"status":"failed","requestedTransport":"sms","transportAggregationState":"excluded","errorCode":"contact_opted_out"}
ERROR LINES [{"closeCode":"retry_opted_out","legOutcome":"suppressed"}]
LEGACY SLOT  {"status":"failed","errorCode":"retry_opted_out"}
```

- **Why the F7 test cannot see this:** `app/test/relayRetryLeg.test.ts:766-772`
  forces the outcome through `legSend.override`, which REPLACES
  `sendOneRelayLeg` entirely (`:68-80`). The extraction's own
  `persistRelayRecipientResult` never runs, so the slot is still `queued` when
  `closeTerminally` fires and the write lands. The test uses
  `seedRetryRow(world)` - whose default is `versioned = true` (`:150`) - so it
  asserts a versioned row and still passes, which is exactly the shape where the
  fix does nothing in production.
- **Minimum:** either gate the `closeCode` log field on the write actually
  landing, or (better, and what the adversarial review's other proposal said)
  pass the gate's suppression answer into `sendOneRelayLeg` so the second read
  cannot disagree. Failing both, the divergence note must say the bound covers
  the LIVE shape, not the historical one.

### 2.3 MEDIUM - F2 buys the escalation by giving up Twilio's redelivery, and pins the loss

- **Where:** `app/src/routes/webhooks/twilio.ts:2914-2929` (the new try/catch);
  the route acks 200 at `:3048`.
- **The trade nobody wrote down:** before F2 a throw inside `claimRelayRetry`
  escaped to Express, the callback got a 5xx, and Twilio redelivered - and D8
  gates the claim on the slot's POST-WRITE STATE rather than on `transitioned`
  (`twilio.ts:2697-2713`) SPECIFICALLY so a redelivered callback can still claim.
  The redelivery was the recovery, and the repo says so in its own words at
  `twilio.ts:2458` ("a 5xx would trigger a redelivery, which dedupes at the
  append and RE-RUNS these idempotent steps"). After F2 the catch acks 200, so a
  DynamoDB throttle on the consistent read, the roster read, or `append` now
  loses the ladder PERMANENTLY - the member never gets the message.
- **The test pins the loss:** `app/test/relayRetryClaim.webhook.test.ts:634`
  asserts `expect(retryRows()).toHaveLength(0)` after the throw. That is now the
  specified behaviour.
- **How proved:** walked (the call site, the ack, and D8's own comment).
- **Minimum:** keep both - catch, log, let the tail run, then rethrow (or set a
  5xx) after the tail so Twilio redelivers. `flagPlacementAttention` is already
  guarded by `if (transitioned)` (`:2985`), which is false on the redelivery, so
  the escalation cannot double-fire. Or accept the loss deliberately and say so
  in the docblock, which currently argues only the escalation half.

### 2.4 MEDIUM - F5 makes an `E2E_*` variable live on production's app hot path

- **Where:** `app/src/jobs/relayRetryLeg.ts:159-181` (`laneBackoffOverride` inside
  `resolveRelayRetryBackoff`), reached from `enqueueRelayRetryLeg` at `:193`,
  whose single caller is the production status webhook (`twilio.ts:2803`).
- **What changed:** the adversarial review recorded, as a corollary that REDUCED
  a concern, that `E2E_RELAY_RETRY_BACKOFF_MS` set in a deployed environment "has
  **no effect on the ladder**", because the app process never registered handlers
  and the parse lived only at registration. F5 deletes that property: in
  production `registeredBackoffMs` is undefined at the only call site, so the
  chain falls straight through to `process.env['E2E_RELAY_RETRY_BACKOFF_MS']` on
  every rung. `E2E_RELAY_RETRY_BACKOFF_MS=1` in the app's environment would fire
  all three rungs within milliseconds, texting a member three times.
- **How proved:** walked; the docblock at `:130-137` states the topology that
  makes it reachable.
- The surrounding comments have not caught up: `scripts/e2e-session.mjs:261-264`
  still says "so production keeps 60/120/240", which is now true only because
  nobody sets the variable, and `relayRetryLeg.ts:154-156` calls it "LANE-ONLY"
  as if that were structural. F5's correctness goal (one resolution for both
  topologies) is right; the guard it removed should be replaced - e.g. ignore the
  env override when `config.jobsQueueUrl` is set.

### 2.5 LOW - F2 emits two ERROR lines for one claim failure, one of them unclassified

`twilio.ts:2919-2928` logs a diagnostic ERROR and `:2972` then logs the failure
marker at ERROR as well. The diagnostic carries no `event` field, so it feeds
`ErrorLogs` (`observability/main.tf:56`, `{ $.level >= 50 }`) but not
`DeliveryFailures`. One throttled claim therefore contributes two datapoints to
the alarm that pages on 3 consecutive buckets. Deliberate or not, it is worth an
`event` value so the line is greppable and attributable.

### 2.6 LOW - F2's catch also swallows a decided claim

`closeRetryLegEnqueueFailed` runs INSIDE the enqueue-failure catch
(`twilio.ts:2813-2819`); if it throws, F2's outer catch reports
`retryClaim: 'claim_failed'` with the message "threw before deciding - no retry
claimed". The claim DID decide - a retry row exists, stranded at `queued` with no
close code - so both the outcome value and the message misdescribe the state. Both
are ERROR, so no alarm is lost; the operator's diagnosis is.

### 2.7 NOTE - F4 fires per rung and per transient pass, where the fan-out fires once

`relayRetryLeg.ts:466-471` sits inside the handler, after the four gates, so a
three-rung ladder with the transient sub-ladder can emit up to nine copies for one
leg; `relayFanOut.ts:1015-1024` emits one per fan-out. Config-gated on
`MEDIA_BUCKET` being unset, which is not the case in dev or prod, so this is a
note rather than a fix.

### 2.8 NOTE - F3's native-group-text case is a fence that cannot fail

`app/test/twilioStatusWebhook.test.ts:1382-1417` appends a real group message and
posts a 30003 receipt for it. A group leg resolves through `getByProviderSid` as a
MESSAGE and never enters the relay branch, so the case asserts today's shared-set
behaviour and would pass with this whole feature reverted. That is a legitimate
fence against a future widening - it just does not close intention 14's
group-text half, which remains proven "by construction" exactly as the
conformance review said.

### 2.9 NOTE - F9 is unpinned

The fix-wave report states plainly that no suite reads the fake's
`listMediaPointers` derivation. `app/test/helpers/twilioWebhookHarness.ts:1356-1362`
is therefore a drift guard with no test; a future edit that drops the `continue`
breaks nothing.

### 2.10 NOTE - F1 inverted an existing assertion, correctly, and it is recorded

`app/test/relayRetryClaim.webhook.test.ts:394-400` moved from ERROR to WARN plus
"zero ERROR lines". That IS the behaviour change, it is disclosed in the report's
divergence 2, and it is the right way round. Recorded so the next reader does not
flag it.

---

## 3. Adjudications challenged, and upheld

### 3.1 F1 (`slot_ineligible` -> WARN) - CHALLENGED on scope

Direction upheld, scope wrong. See 2.1: the adjudication reasons entirely about
`delivered` and 30007 and then whitelists an outcome value that also covers an
ABSENT slot and a refused slot write. `app/src/routes/webhooks/twilio.ts:411-416`
vs `:2707`. Consequence: an internal anomaly on a terminal 30003 is silently
WARN, which is the same class of error the adjudication was correcting, pointed
the other way.

### 3.2 F7's bounded scope - CHALLENGED

The bound is stated against the wrong population. See 2.2 for the proof and the
file:line chain. Consequence: a fix reported as landed is inert for all current
traffic, and the ERROR line asserts a close code that was not written.

### 3.3 F11 filed rather than fixed - UPHELD, with a rider

The scope call is correct: spec Sec 9 paragraph 1 records the window, the closed
anchor excludes any reconciliation mechanism, and
`docs/issues/relay-retry-stranded-claim-window.md` is faithful (its `refs:` line
numbers check out - `twilio.ts:2742` is the `append`, `:2795` the dedupe return,
`:2803` the enqueue). The rider is finding 1.1: filing the MECHANISM is right,
but the branch also ships the state with no log signal and no on-screen code, and
those two are inside the delivered feature rather than inside the deferred sweep.

### 3.4 Q1 (gate refusals at ERROR) - UPHELD, and the reviewer's alarm argument is overstated

Leaving it at the approved value is right. But the argument that swung it - that
`error-logs-sustained` "pages at threshold 1 over three buckets" - does not apply
to Q1: that alarm needs 3 CONSECUTIVE 5-minute datapoints
(`infra/modules/observability/main.tf:186-203`), and an operator closing a group
or removing a member produces a burst inside ONE bucket. Nor does the shape
recur: once a member is opted out, `isMemberSuppressed` refuses at the FAN-OUT,
so no leg is sent and no 30003 arises. Q1 is a log-hygiene question, not a paging
one; the paging question is Q4's.

### 3.5 Q2 (an `unconfirmed` leg loses its carrier code) - CHALLENGED

The adjudication frames the choice as "keep D19's label, or change copy the
founder has not seen". There is a third option the branch already built: a
presentation may carry its OWN `reason`, and `presentLegDelivery` uses that
channel for `Retrying` (`deliveryStatus.ts:679-685`), with both consumers now
preferring it (`Timeline.tsx:602-612`, `:1253-1259`). Giving the `unconfirmed`
arm (`deliveryStatus.ts:692-700`) the original's reason changes no LABEL and
needs no founder decision; it needs `projectOneLeg` to carry the original code
past `withDecidingRung` (`relayRetryJoin.ts:365-368`), which today discards it.
Consequence of leaving it: combined with 1.1, the stranded case has neither an
alarm nor a code anywhere. The CHIP half is harder (the `retrying || notConfirmed`
branch has no `reason` at all, `deliveryStatus.ts:531-537`) and can stay open;
the row and the recital should not.

### 3.6 Q3 (the unkeyed digest) - UPHELD as an OPEN, with one added fact

D3/D5 specify the construction, so OPEN is procedurally right. The added fact is
1.4: F8's resolution means the digest and its salt are both in the JSON the
browser receives (`app/src/routes/api.ts:2160-2174`, verified - no projection
step). The human deciding Q3 should be told that the pre-image is recoverable
from data the CLIENT holds, not only from a sort key.

### 3.7 Q4 (alarm volume) - UPHELD as an OPEN, and understated

"One `cap_exhausted` ERROR per relayed message" is the ERROR half. The metric half
is finding 1.2: up to four `delivery_failed` events per message per dead handset,
against an alarm that fires on a single 5-minute period. Both numbers belong in
front of the human before prod.

### 3.8 Q5 (the retry bubble's chip vs its own row) - UPHELD

Cosmetic, correctly reasoned, and D21's agreement rule genuinely governs the
ORIGINAL bubble's three positions, which do agree
(`deliveryStatus.ts:546-552` is reached only for a bubble that IS the retry row).

### 3.9 The RECORDs (A10, A11, A12, A14, C4, C7) - UPHELD

A10 in particular I tried to break and could not: see the "swept with no finding"
entry - the TEAM sentinel is handled, so the drift really is a seconds-wide
rename window and not a systematic mis-attribution.

---

## 4. Are the eleven fixes REAL?

| Item | Verdict | Reason |
|---|---|---|
| F1 | **REAL, over-broad** | `twilioStatusWebhook.test.ts:1345` and `:1363` both assert zero relay ERRORs plus a WARN carrying `slot_ineligible`; reverting `twilio.ts:415` puts the line back at ERROR and both fail. But nothing pins the other two producers of that outcome, which regressed (2.1). |
| F2 | **REAL, with a new cost** | `relayRetryClaim.webhook.test.ts:618` rejects `append` once and asserts the ERROR marker, its own message, the SSE and exactly one escalation; without the try/catch the rejection escapes and the post 500s, so the test fails. The cost is 2.3, and the same test pins it. |
| F3 | **REAL for one half, VACUOUS for the other** | The delivered-slot half IS F1's `:1345` and fails on revert. The group-text case (`:1387`) passes with the whole feature reverted (2.8). |
| F4 | **REAL** | `relayRetryLeg.test.ts:580` asserts the line's `mediaCount`, its message, that the rung still sent, and no PII, behind an explicit `expect(createMediaStore()).toBeUndefined()` precondition; `:602` is the negative fence. Deleting `relayRetryLeg.ts:466-471` fails both. |
| F5 | **REAL** | `relayRetryLeg.test.ts:973` (nothing registered, env set, expect `[9,9,9]`) fails on the pre-fix chain, which resolved `registeredBackoffMs ?? relayRetryBackoffMs` and would give `[60,120,240]`. The malformed `it.each` at `:979` covers the guard on the new path. See 2.4 for what it also removed. |
| F6 | **PLAUSIBLE** | A config change with no pinning test: nothing fails if `scripts/e2e-session.mjs:269` goes back to `'3000'`, only the flake returns. The two green runs are evidence the window widened, not that it stays wide. The spec's new comment ("raise the lane backoff, NEVER weaken the assertion") is the only guard. |
| F7 | **NOT-FIXED on the live shape** | Proven inert on a versioned retry row, which is what the claim mints from every source written today; REAL only for legacy rows. The named test (`relayRetryLeg.test.ts:766`) passes on a VERSIONED row solely because `legSend.override` replaces the writer, so it cannot fail for the reason the fix exists. See 2.2. |
| F8 | **REAL** | Comment-only, and the corrected claim is true: `app/src/routes/api.ts:2160-2174` returns the page as-is apart from `relay_external_caller_display_name`. All four sites now say "projected", not "on the wire". |
| F9 | **REAL as a change, PLAUSIBLE as a guard** | `twilioWebhookHarness.ts:1356-1362` does skip retry rows and now matches `messagesRepo.ts:2373`. No test reads that derivation, so nothing holds it there (2.9). |
| F10 | **REAL** | Verified by grep: `presentRelayDelivery` / `presentLegDelivery` appear outside `deliveryStatus.ts` only in `Timeline.tsx` (and its tests). The corrected comments at `:384` and `:555` are accurate. |
| F11 | **REAL** | `docs/issues/relay-retry-stranded-claim-window.md` exists, is `status: open`, carries the interleaving, the `dueRow` proposal and the duplicate-send warning in its own paragraph, its `refs:` line numbers resolve, and the anchor's residuals paragraph links it. |

---

## Verdict

The branch is **not yet merge-ready**, but the gap is narrow and none of it is
structural: the feature's design, its fences, its join and its presenter hold up
under a second pass, the single main merge is clean at both the diff and the test
level, and the harness fake now mirrors the real repo for every method the branch
added. What blocks it is that fix wave 1 - written under pressure against a
critique, exactly as the charge predicted - shipped two fixes that do not do what
they say and one that traded a recovery path away silently, and the R1
adjudications left three separately-acceptable residuals that compose into one
member never receiving a relayed message with no alarm, no carrier code on screen
and no retry affordance. The minimum that must change before merge: (1) narrow
F1's whitelist to the two shapes it was argued for, so an ABSENT slot on a
terminal 30003 alarms again (`twilio.ts:411-416`); (2) make F7 either work on a
versioned row or stop claiming it does - at minimum gate the `closeCode` log
field on the write landing, and correct the divergence note, which has the live
and historical populations the wrong way round; (3) restore a recovery path for a
thrown claim, or state in the docblock that the ladder is deliberately abandoned
there (`twilio.ts:2914-2929`); and (4) restore F5's lost guard so a stray
`E2E_RELAY_RETRY_BACKOFF_MS` cannot reshape a real ladder in the app process.
Finding 1.1 and adjudications Q2 and Q4 should go to the human as one question
rather than three - they are the same operator, on the same screen, on the same
day - but they are decisions, not defects, and they need not block the merge.

Reviewer: code review R2, re-review. No source file was edited; two throwaway
suites were written, run and deleted; four unmodified dashboard suites were run;
no commit was made; the working tree carries only this file.
