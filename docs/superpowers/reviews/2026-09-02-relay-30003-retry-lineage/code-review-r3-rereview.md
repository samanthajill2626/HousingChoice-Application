# Code review R3 - scoped re-review of fix wave 2

Branch `feat/relay-30003-retry-lineage` @ `6e4bd4ce`, wave 2 = `a0fe28d2..6e4bd4ce`.
Fresh reviewer: wrote no prior review and no fix wave.

Read in order: `code-review-r2-adjudications.md`, `code-review-r2-rereview.md`,
`.superpowers/review/fix-wave-2-diff-package.md`, `fix-wave-2-report.md`, then
the live tree (twilio.ts, relayFanOut.ts, relayRetryLeg.ts, relayRetryClaim.ts,
errors.ts, app.ts, index.ts, config.ts, messagesRepo.ts, deliveryStatus.ts,
relayRetryJoin.ts, Timeline.tsx, messageTransport.ts).

Method. Two throwaway suites were written, run and DELETED
(`app/test/_review_scratch_r3.test.ts`,
`dashboard/src/routes/contact/_review_scratch_r3.test.ts`); their output is
quoted below. Nine suites were run UNMODIFIED at HEAD and are all green: app
`relayRetryLeg` 50, `relayFanOut` 81, `relayRetryClaim.webhook` 30,
`relayRetryClaim` 5, `twilioStatusWebhook` 52, `twilioWebhookHarnessMediaIndex`
2, `relayAnnouncements` 19, `relayWebhook` 27, `relayApi` 59; dashboard
`relayRetryJoin` 36, `deliveryStatus` 134, `Timeline.ticker` 33,
`Timeline.delivery` 35, `Timeline` 155. The four relay suites total **186**, so
W4's byte-identical-fan-out claim is confirmed by measurement. No tracked file
was edited; no commit; `git status` carries only this file.

Counts: **LOW 3 / NOTE 2**. No BLOCKING, HIGH or MEDIUM finding.

---

## 1. Findings in the wave-2 diff

### 1.1 LOW - W2 does NOT produce one ERROR line; a throttled claim still emits two, and the second is now the LESS attributable one

- **Where:** `app/src/routes/webhooks/twilio.ts:3111` (the rethrow) meets
  `app/src/lib/errors.ts:196-200`, mounted at `app/src/app.ts:300`. The claim to
  the contrary is in the code at `twilio.ts:3033-3038` ("One line, one `event`")
  and in the record at `fix-wave-2-report.md:90-91` ("One ERROR line per
  throttled claim, not two").
- **The failure:** the fold removed the deliberate diagnostic, and the rethrow
  immediately re-added a generic one. The express handler logs at ERROR with
  `err`, `method` and `path` - and with no `event`, no `retryClaim` and no
  `memberKey`, so it feeds `ErrorLogs` (`observability/main.tf`, `$.level >= 50`)
  exactly as the line it replaced did, while being strictly harder to attribute.
  R2's 2.5 counted precisely this ("two datapoints to the alarm that pages on 3
  consecutive buckets"), and it is unchanged.
- **How proved:** reproduced, one 30003 with `append` rejected once:

```
ERROR LINE COUNT 2 [{"msg":"...the retry claim itself threw...","event":"delivery_failed","rc":"claim_failed"},
                    {"msg":"unhandled error while handling request: POST /status"}]
```

- **Minimum:** correct both statements. Two ERROR lines is the honest price of
  the rethrow and is defensible; asserting one is what a future reader will tune
  a threshold against. (An `event` on the express line is not available - it is
  shared by every route.)

### 1.2 LOW - the rethrow multiplies `delivery_failed` per Twilio redelivery, and Q4 does not count that multiplier

- **Where:** `app/src/routes/webhooks/twilio.ts:3026-3062` (the marker) runs
  BEFORE `:3111`, so every redelivery re-emits it; the W9c comment at
  `:3016-3025` names only root + three rungs.
- **The failure:** one leg failure whose claim throws produces a
  `delivery_failed` on the 5xx AND another on the redelivery that the 5xx
  triggered. A fault lasting several redeliveries multiplies again, on the same
  raw-Sum single-period alarm W9c hands to the human as Q4.
- **How proved:** reproduced - one seeded failure, one rejection, one replay:

```
DELIVERY_FAILED TOTAL AFTER REDELIVERY 2 [{"rc":"claim_failed"},{"rc":"claimed"}]
RETRY ROWS AFTER REDELIVERY 1
```

- **Minimum:** one sentence in the W9c comment and in Q4. The recovery itself is
  correct - the row count of 1 above is W2 working.

### 1.3 LOW - W5's chip reason is UNFENCED: it reads `errorCode` off the pre-existing staleness half of J, where the repo's own rule says a code does not imply failure

- **Where:** `dashboard/src/routes/contact/deliveryStatus.ts:540` (the branch)
  and `:554` (`joinReasons([...retryingLegs, ...notConfirmedLegs])`). The rule it
  breaks is stated in this feature's own code at
  `dashboard/src/routes/contact/Timeline.tsx:1250-1252`. The producer of a
  non-terminal leg carrying a code is `app/src/jobs/relayFanOut.ts:1414-1421`
  (`{ status: 'queued', errorCode: <transient code> }`).
- **The failure:** `notConfirmedLegs` is a UNION - the retry `unconfirmed` legs
  AND every `isStaleLeg` leg, including legs with no ladder anywhere. Any code on
  one of those now reaches the chip, and `deliveryReason` renders an unmapped
  code as "Delivery failed (error N)". The chip then asserts a failure about a
  leg the same call reports `isFailure: false`, and the ROW for that leg says
  nothing of the kind - the stale branch at `deliveryStatus.ts:749-751` adds no
  reason. Chip and row disagree (D21), on a leg outside this feature.
- **How proved:** reproduced, `retryAware: true` (what a relay bubble passes,
  `Timeline.tsx:1060`), one delivered leg plus one quiet `sent` leg carrying
  `30022` and NO `retryState`:

```
CHIP  {"label":"delivered 1/2 - 1 not confirmed","isFailure":false,"reason":"Delivery failed (error 30022)"}
ROW   {"label":"Sent - not confirmed","tone":"danger","isFailure":false}
```

- **Reachability is narrow today**, which is why this is LOW: the fan-out's
  transient write is cleared by the next successful write
  (`app/src/repos/messagesRepo.ts:3390-3394` - `sent` is a successful status),
  and a bare `queued` slot has no staleness clock (`stalenessClockMs`). It needs
  a `sent`-status slot that acquired a code - e.g. `updateRecipientDeliveryStatus`
  merging a provider `sent` callback that carries an `ErrorCode`.
- **The wave's own fence misses it.** `deliveryStatus.test.ts:1246` ("adds no
  reason when the not-confirmed legs carry no code") pins exactly the case that
  was already safe.
- **Minimum, one line:** build the reason from the RETRY legs only -
  `retryingLegs` plus the legs whose `retryState === 'unconfirmed'` - rather than
  from the whole J union. That is the state W5 was adjudicated for, and it leaves
  the staleness half byte-identical instead of nearly so.

### 1.4 NOTE - `withDecidingRung`'s third parameter is a positional boolean

`dashboard/src/routes/contact/relayRetryJoin.ts:261-264`. Two call sites, one
passing a bare `true` (`:382`). The module next door argues at length for an
options bag over positional arguments (`deliveryStatus.ts`, `presentRelayDelivery`
docblock) for exactly this reason. Cosmetic; recorded so it is not re-found.

### 1.5 NOTE - `EMPTY_RETRY_INDEX` is a shared mutable `Map`, not a `ReadonlyMap`

`dashboard/src/routes/contact/Timeline.tsx:849`. The comment's safety argument
("every reader below is read-only") is correct today - `indexRelayRetries` builds
its own map (`relayRetryJoin.ts:156`) and `projectRelayLegs` only `.get`s
(`:433`) - but the TYPE does not enforce it, and one shared instance leaks across
every mounted Timeline if that ever changes. `ReadonlyMap` on the constant and on
`hasTickableLeg`'s parameter would make it structural.

---

## 2. Are the nine corrections REAL?

| Item | Verdict | Evidence |
|---|---|---|
| W1 | **REAL** | The split is exactly the adjudicated one (`twilio.ts:2744-2752`: absent -> `slot_ineligible`, `delivered` -> `slot_settled`, non-terminal -> `slot_ineligible`, other terminal code -> `slot_settled`), and `isTerminalRelayLegFailure` now WARNs only `slot_settled` (`:443`). Reverting that WARN arm fails both new cases, which assert `relayFailureLines(WARN)).toHaveLength(0)` (`twilioStatusWebhook.test.ts:1389`, `:1406`); the two re-pointed cases (`:1352`, `:1370`) assert a value that does not exist pre-W1. All four producers of the old catch-all are covered. |
| W2 | **REAL for the rethrow, the recovery and 2.6; NOT-FIXED for 2.5** | `relayRetryClaim.webhook.test.ts:636` asserts `res.status === 500` and `:677` asserts the redelivery claims - both fail without `twilio.ts:3111`. The separately-guarded close (`:2859-2890`) keeps `enqueue_failed`, omits `closeCode` and 200s, pinned at `:699`. Every step before the rethrow is idempotent on the redelivery: the slot write is forward-only (`transitioned` false), the escalation is gated on it (`:3074`), and the append dedupes on the deterministic `relayretry-<digest>-<attempt>` SID (`:2831`), so no double claim and no double send. 2.5 is finding 1.1. |
| W3 | **REAL, and structurally so** | `laneBackoffOverride` returns undefined on a non-empty `JOBS_QUEUE_URL` (`relayRetryLeg.ts:183-184`). The discriminator is the right one and is enforced elsewhere: production fail-fasts without it (`app/src/lib/config.ts:1105`, pinned by `app/test/app.test.ts:199`), and the app registers handlers only when it is unset (`app/src/index.ts:42`). The empty-string edge agrees with `config.jobsQueueUrl`'s own falsiness, so the two readings cannot diverge. Four cases cover both topologies on both paths plus the empty string. |
| W4 | **REAL** | The read window is closed at the source rather than papered over: `relayFanOut.ts:1310` skips the duplicate read, the fan-out passes nothing (`:1126`), the re-stamp and the false `closeCode` are gone (`relayRetryLeg.ts:620-627`). `relayRetryLeg.test.ts:774` uses the REAL `sendOneRelayLeg` on the default VERSIONED seed and asserts `reads === 1` - which is the read `isMemberSuppressed` actually makes (`relayAnnouncements.ts`, `contacts.getById`), so `suppressionChecked: false` gives 2. The gate and the send are separated by no `await` (`relayRetryLeg.ts:479` to `:506`), so the opt-out window given up is real but sub-millisecond. Fan-out unchanged at 186, measured. |
| W5 | **REAL** | `withDecidingRung(..., true)` on the quiet branch only (`relayRetryJoin.ts:382`); the delivered branch still clears, still asserted (`relayRetryJoin.test.ts:353`). Row, recital and chip all name the code (`Timeline.delivery.test.tsx:1026`). No other `.errorCode` reader in `dashboard/src` is disturbed: the `contact_opted_out` denominator filter (`deliveryStatus.ts:449`), the "Not sent - opted out" short-circuit (`:673`) and both `messageTransport.ts` readers (`:46`, `:63`) are unreachable for a projected `unconfirmed` leg, because the claim gate admits only a 30003-or-absent code and `withDecidingRung` strips the original's `transportAggregationState`. The chip half carries finding 1.3. |
| W6 | **REAL** | `presentLegDelivery`'s fifth parameter defaults to `{ relay: true }`, so every prior caller is byte-identical, and both Timeline sites build ONE bag for the presenter and their own fallback (`Timeline.tsx:605-614`, `:1241-1252`). All three `recipientSummaryName` call sites pass the same `isMms`. The test compares against `deliveryReason` directly and asserts the two option sets really differ. |
| W7 | **REAL as a pin** | `app/test/twilioWebhookHarnessMediaIndex.test.ts`, 2 cases, asserting the OWNER and not only the count, with a no-lineage control. |
| W8 | **REAL** | `Timeline.tsx:2036-2039`. `rosterKind` defaults to `'relay'` at the Timeline itself (`:1779`) and is the same value passed to every bubble (`:2525`), so the gate and the projection's `isRelayLeg` cannot disagree. The memo deps are correct (`rosterKind` is a primitive) and the empty map is referentially stable, so `tickerArmed`'s memo (`:2090-2093`) does not recompute. |
| W9c | **REAL as far as it goes** | The comment now states both halves correctly. Incomplete only in the way finding 1.2 describes. |

---

## 3. Anything reopened?

Nothing R1 or R2 closed was re-broken. Specifically checked and clean: F1's
approved WARN shapes still WARN; F7's defect is closed at the source rather than
re-stamped, and A7 cannot recur on a versioned row; F5's one-resolution property
survives the guard (the lane still shortened its rung in the wave's e2e run);
the fan-out is byte-identical by construction and by count; no fenced file is in
the diff.

The one item that is NOT closed is R2's own 2.5 - see finding 1.1. It was
adjudicated as part of W2 and the wave reports it as done.

---

## 4. Adjudications challenged, and upheld

- **W2's 2.5 clause - CHALLENGED.** "Fold the diagnostic line into the failure
  marker (attach `err`; one ERROR line, one `event`)" cannot hold together with
  the rethrow the same item requires: the mounted handler
  (`app/src/lib/errors.ts:196`) logs its own ERROR for every 5xx. The
  implementation satisfied the rethrow and silently dropped the other half.
  Consequence: `fix-wave-2-report.md:90-91` and `twilio.ts:3037` both assert a
  line count that is wrong by one.
- **W5's chip half - CHALLENGED on scope.** R2's own 3.5 said "the CHIP half is
  harder ... and can stay open; the row and the recital should not." The
  adjudication took it anyway, and it is the only place in the wave where a
  presentation outside the retry states changed. Consequence: finding 1.3.
- **Q4 - UPHELD as an OPEN, with one added multiplier.** W2's rethrow means the
  marker repeats per redelivery, so the number in front of the human is not four
  per message but four times however many times Twilio redelivers a 5xx'd
  callback.
- **W1, W3, W4, W6, W7, W8, W9c - UPHELD.** Each is implemented as adjudicated,
  and W1, W3 and W4 are better than the minimum R2 asked for (a second outcome
  rather than a widened predicate; a structural discriminator rather than a
  config one; closing the read window rather than gating a log field).
- **Q1, Q3, the F11 rider, and the RECORDs 2.7 / 2.8 / 2.10 / F6 - UPHELD.** Out
  of this pass's scope and no new evidence bears on them.

---

## 5. Verdict

Wave 2 is sound. Every one of the nine items is really implemented, each is
pinned by a test that fails when the change is reverted, and the four corrections
to wave 1 are all better than the minimum R2 named: W1 split the outcome instead
of widening a predicate, W3 replaced a lost guard with a structural one the
config layer already fail-fasts on, W4 closed the read window at the source
rather than re-stamping after it, and W2 kept both the tail and Twilio's
redelivery in the only order that gets both - with the redelivery proved to
recover the ladder and the escalation proved not to double-fire. Nothing R1 or R2
closed was reopened, no fenced file was touched, and the fan-out is byte-identical
at 186 tests. **From a code-review standpoint this is merge-ready.** Nothing here
is blocking; the three LOW items are worth one small follow-up commit rather than
another wave: (1) correct the "one ERROR line" claim in `twilio.ts:3037` and
`fix-wave-2-report.md:90-91`, which is false in the delivered code; (2) add the
redelivery multiplier to the W9c comment and to Q4 before the human sets that
threshold; and (3) narrow `deliveryStatus.ts:554` to the retry legs, so the chip
cannot print "Delivery failed" about a leg it simultaneously reports as
`isFailure: false` while the row beside it prints nothing. Item (3) is the only
one that can change a pixel.

Reviewer: code review R3, scoped re-review of fix wave 2. No source file was
edited; two throwaway suites were written, run and deleted; fourteen unmodified
suites were run; no commit was made; the working tree carries only this file.
