# Provider-status enumeration - DRAFT (raw list for slice 6 to finalize)

**Status: DRAFT ENUMERATION. No dispositions are decided here.** This is the raw
sweep required by spec Sec 9 and plan slice 6. A later slice decides fix-here vs
file, writes `provider-status-sweep.md`, and files the out-of-region issue.

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`,
HEAD `8c8b7100` (main merged). Read-only pass: no source file was edited.

## The shape being hunted

From `docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md` (the
"also worth auditing" paragraph) and the 2026-08-16 voice incident: **a branch on
a raw provider status string whose UNENUMERATED default is NON-TERMINAL ("not
finished yet, keep waiting") rather than terminal.** A status Twilio actually
returned (`error`) was not in the enumeration, fell into the keep-waiting arm,
and a 1-second voicemail sat on "Transcribing..." forever.

`EXPOSED` below means that polarity: a non-terminal / keep-waiting / no-change
default on a status that can be terminal. `NOTE` means an unenumerated default
that is terminal but still worth a reader's attention (fail-open, mislabel,
silent drop). `SAFE` means the default is terminal or the value set is a closed
TypeScript union the compiler makes exhaustive.

## What was searched

Directory: `app/src` only. `dashboard/` was excluded by instruction
(presentation, not provider branching); `*.test.ts` / `__tests__` were excluded.

Grep patterns run (ripgrep / grep -rn from `app/src`):

```
!== 'success'          'success'              switch (
status ===   status !==   Status ===   Status !==
state ===    state !==    State ===    State !==
MessageStatus  SmsStatus  CallStatus  DialCallStatus  CallbackSource
TranscriptionStatus  RecordingStatus
eventType  notificationType  SesEventType
mapProviderStatus  normalizeStatus  toDeliveryStatus  isTerminal
code === '<lit>'   code === "<lit>"   code === <num>   Code ===   .code)
21610 30003 30005 30006 30007 30022 20404 21710 21714 50353 50513
spamVerdict  virusVerdict  quarantined  warming  stop_reason
```

Directories read line-by-line for context: `app/src/adapters/*`,
`app/src/routes/webhooks/*`, `app/src/jobs/*`, `app/src/services/*voice*`,
`*email*`, `*ses*`, `*group*`, `*relay*`, plus `repos/messagesRepo.ts` and
`repos/broadcastsRepo.ts`.

## Regions (spec Sec 2)

- **IN-REGION** (files this branch already edits): `jobs/broadcastFanOut.ts`,
  `jobs/relayFanOut.ts`, `services/groupRail.ts`, `repos/messagesRepo.ts`,
  `repos/broadcastsRepo.ts`.
- **FENCED**: `routes/webhooks/twilio.ts` **in its entirety**,
  `repos/conversationsRepo.ts`, `jobs/tourReminders.ts`, `routes/contacts.ts`,
  `routes/today.ts`, `lib/rosterResolution.ts`. Audited, never fixed.
- **OUT-OF-REGION**: everything else in `app/src`. File, do not fix.

Only `twilio.ts` among the fenced files carries any provider-status branch; the
other five were searched and returned only internal-domain status branches
(`conversation.status`, `tour.status`, roster row `status`), which are out of
scope for this sweep.

## The table

`Default` = what an UNENUMERATED provider value does.

### IN-REGION

| # | file:line | branched on | enumerated | default | verdict |
|---|---|---|---|---|---|
| 1 | `app/src/jobs/broadcastFanOut.ts:123-127` | `BroadcastRecipient['status']` (our slot state, provider-derived) | `sent`, `delivered`, `failed`, `skipped` | non-terminal (`false` = re-send it) | SAFE - closed TS union; only `queued` remains |
| 2 | `app/src/jobs/broadcastFanOut.ts:408-418` | Twilio send-error `code` (via `errorCodeOf`, :153-162) | `30007` | falls through to 3/4/5 | SAFE |
| 3 | `app/src/jobs/broadcastFanOut.ts:420-447` | same `code` | `30005`, `30006` (`UNREACHABLE_CODES`, :91) | falls through to 4/5 | SAFE |
| 4 | `app/src/jobs/broadcastFanOut.ts:449-454` | same `code` | `429`, `30022` (`TRANSIENT_CODES`, :87) | falls through to 5 | SAFE |
| 5 | `app/src/jobs/broadcastFanOut.ts:456-459` | same `code` - the catch-all arm | (none) | **`throw err`** - recipient left `queued`, loop exits, 798 of 800 stranded | **EXPOSED - D12, FILED NOT FIXED** |
| 6 | `app/src/jobs/relayFanOut.ts:168-170` | `RelayRecipientDelivery['status']` | `sent`, `delivered`, `failed` | non-terminal (`false`) | SAFE - closed union |
| 7 | `app/src/jobs/relayFanOut.ts:887-892` | Twilio send-error `code` (`errorCodeOf`, :1142-1150) | `30007` | falls through | SAFE |
| 8 | `app/src/jobs/relayFanOut.ts:893-899` | same `code` | `429`, `30022` (:83) | falls through | SAFE |
| 9 | `app/src/jobs/relayFanOut.ts:901-904` | same `code` - catch-all arm | (none) | **`throw err`** - same shape as #5 | **EXPOSED - D12, FILED NOT FIXED** |
| 10 | `app/src/jobs/relayFanOut.ts:909` | `result.status` (the adapter's already-mapped `DeliveryStatus`, itself `mapTwilioStatus` output) | `queued` | **terminal-success**: every other value, `failed`/`undelivered` included, is written as `sent` | NOTE - self-corrects via the forward-only DLR (`sent -> failed` is an allowed prior), but a create that came back `failed` is briefly recorded as sent |
| 11 | `app/src/services/groupRail.ts:259-262` | Twilio Conversations `conversation.state` (raw string off the vendor read) | `closed`, `failed`; `undefined` defaults to `active` | **non-terminal** - anything else is "a rail that still works or is about to" | **EXPOSED** - named by plan slice 6; the two consumers are :433 (adopt) and :484 (the ensure gate) |
| 12 | `app/src/repos/broadcastsRepo.ts:226-248` | `slot.status` in `deriveBroadcastStats` | `queued`, `sent`, `delivered`, `failed`, `skipped` | falls out of the switch counted in NO bucket (`audience` would exceed the sum) | SAFE by type - closed union, no `default` arm |
| 13 | `app/src/repos/messagesRepo.ts:111-133` | `DeliveryStatus` forward-only map `ALLOWED_PRIOR` | all six values, total `Record` | n/a - total map over a closed union | SAFE |
| 14 | `app/src/repos/messagesRepo.ts:72-87` | `CallStatus` forward-only map | all seven values, total `Record` | n/a | SAFE |
| 15 | `app/src/repos/messagesRepo.ts:2805-2812` | `slot.status` vs `allowedPriorStatuses(status)` | the allowed-prior list | skip the write, log "would regress" | SAFE |
| 16 | `app/src/repos/messagesRepo.ts:2828-2832` | mapped `status` | `delivered` | no `deliveredAt` stamp | SAFE |

### FENCED - `routes/webhooks/twilio.ts` (audit only; every finding is FILED)

| # | file:line | branched on | enumerated | default | verdict |
|---|---|---|---|---|---|
| 17 | `app/src/routes/webhooks/twilio.ts:295-299` | `ErrorCode` severity taxonomy `isTerminalDeliveryFailure` | `21610` (:287), `30003` (:286) | **terminal** - "A failure with no code, or any unrecognized code, is treated as terminal (fail loud, not silent)" | SAFE - the explicit counter-example to the voice shape |
| 18 | `app/src/routes/webhooks/twilio.ts:2359` and `:2470` | raw `MessageStatus` via `mapTwilioStatus` | see #27 | **non-terminal `queued`** (inherited from #27) | **EXPOSED (inherited)** - FENCED |
| 19 | `app/src/routes/webhooks/twilio.ts:2377`, `:2484`, `:2541` | mapped `DeliveryStatus` | `undelivered`, `failed` | no failure marker / no escalation | SAFE - the mapped value is already terminal or not |
| 20 | `app/src/routes/webhooks/twilio.ts:2552-2726` | `switch (ErrorCode)` | `30003`, `30005`, `30006`, `30007`, `21610` | `default:` at :2721 - ignore + WARN, "no automated action" | SAFE - the status itself was already stamped terminal at :2471 |
| 21 | `app/src/routes/webhooks/twilio.ts:2779-2785` | mapped `deliveryStatus` in `rollIntoBroadcast` | `delivered`, `failed`, `undelivered`, `sent` | `return` - no slot change (`queued`/`queued_pending`) | NOTE - deliberate; the fan-out owns the pre-carrier slot |
| 22 | `app/src/routes/webhooks/twilio.ts:2415-2463` | not a status - SID resolution | message / relay pointer / system marker | ERROR + 200 ack, delivery outcome dropped | NOTE - terminal-ish (loud), listed because it is the loop-closing backstop |
| 23 | `app/src/routes/webhooks/twilio.ts:2747` | `broadcastSlotMayTransition(slot.status)` | non-terminal predecessors | refuse the transition | SAFE |

### OUT-OF-REGION

| # | file:line | branched on | enumerated | default | verdict |
|---|---|---|---|---|---|
| 24 | `app/src/adapters/messaging.ts:533-548` | **raw Twilio `MessageStatus`** - `mapTwilioStatus`, the repo's single most-used mapper | `sent`; `delivered`/`read`; `undelivered`; `failed`/`canceled` | **`default: return 'queued'`** - its own comment says "accepted \| scheduled \| queued \| sending \| anything new Twilio adds" | **EXPOSED - the root site.** Any future terminal `MessageStatus` reads as non-terminal `queued` at every caller (#18, #10, `relayAnnouncements`, `sendMessage`) |
| 25 | `app/src/adapters/messaging.ts:520-530` | `err.code` then `err.status` extraction | n/a | `undefined` | SAFE - extractor, not a branch |
| 26 | `app/src/adapters/messaging.ts:826-841` | attach-number error `code` | `21710` (idempotent success), `21714` (`PoolFullError`) | `throw err` - terminal | SAFE |
| 27 | `app/src/adapters/messaging.ts:955-961` | `e.status` / `e.code` on a fetch | `404`, `20404` | rethrow | SAFE |
| 28 | `app/src/routes/webhooks/voice.ts:216-236` + `:1630-1637` | **raw `CallStatus` / `DialCallStatus`** via `mapCallStatus` | `ringing`, `in-progress`/`answered`, `completed`, `no-answer`, `busy`, `failed`, `canceled` | **`return undefined`** -> `:1631-1637` acks with empty TwiML and **"make no change"**; the call row stays `ringing`/`in-progress` | **EXPOSED** - same family as the 2026-08-16 incident, one channel over |
| 29 | `app/src/routes/webhooks/voice.ts:1916-1920` | raw `RecordingStatus` | `completed` (and `undefined`) | ignore + 200; nothing marks the recording terminal | NOTE - Twilio also emits `absent` / `failed`; neither is recorded anywhere |
| 30 | `app/src/services/voiceTranscripts.ts:116-120`, `:198-213` | **raw Twilio VI transcript `status`** | terminal-failure set `failed`, `error`, `canceled`; then `completed` | `'not-completed'` - **non-terminal**, but capped by `RECONCILE_MAX_ATTEMPTS` (`jobs/voiceTranscript.ts:31`) which stamps `failed` | SAFE-BY-CAP - **this is the a755c6f8 patch itself**; keep as the reference shape, its docblock at :101-115 states the incident |
| 31 | `app/src/jobs/voiceTranscript.ts:116-142`, `:204-226`, `:278-303` | enqueue outcome, not a provider status | n/a | **an enqueue failure CLOSES the lifecycle** (`tryReenqueue` returns queued=false -> stamp failed) | SAFE - the in-repo precedent for D9; listed for comparison |
| 32 | `app/src/services/groupReceipts.ts:125-144`, `:545-559` | **raw Conversations delivery `Status`** via `conversationsStatusRuling` | `sent`, `delivered`, `undelivered`, `failed`, `read`, `queued`, `sending`, `accepted`, `scheduled` | **unmapped -> `dropped`** + ERROR log; the slot stays at its seeded `queued` (non-terminal) | NOTE (near-EXPOSED) - deliberate ("dropped rather than guessed"), logged at ERROR, and backstopped by #34's staleness alarm |
| 33 | `app/src/services/groupReceipts.ts:157-161` | same raw status, `receiptRank` | mapped statuses | unmapped or ignore -> rank `0` | SAFE |
| 34 | `app/src/services/groupDelivery.ts:98-120` | our slot statuses, aggregate rollup | `TERMINAL` set, `sent`, suppressed | anything still `queued` -> `queued`, i.e. NO CHANGE (caller skips the write) | SAFE - deliberate, documented at :88-90 |
| 35 | `app/src/services/groupSendStaleness.ts:53-61`, `:79-81`, `:119-125` | slot `status` string | `delivered`, `failed`, `undelivered` (+ the synthetic suppression code) | non-terminal -> the alarm KEEPS waiting, then fires ERROR at the deadline | SAFE - not-terminal here means "alarm", not "hang" |
| 36 | `app/src/services/relayAnnouncements.ts:306-311` | `result.status` from the adapter | `queued` | everything else written as `sent` | NOTE - identical to #10 |
| 37 | `app/src/routes/webhooks/twilioConversations.ts:165-215` | Conversations `EventType` | `onDeliveryUpdated`, `onMessageAdded` | `default:` WARN + `200 ok, ignored` - never a 500 | NOTE - `onDeliveryUpdated` is the ONLY receipt channel for group sends, so a renamed/filtered event looks like total silence; #35 is the backstop |
| 38 | `app/src/routes/webhooks/twilioEvents.ts:152`, `:179`, `:185-190` | CloudEvents `type` (A2P number registration) | `...number-registration.successful`, `...number-deregistration.successful` | INFO + ignore | NOTE - a `registration.failed` event leaves the number `warming` forever; backstopped by the stuck-warming ERROR sweep at `services/poolNumbers.ts:459-478` |
| 39 | `app/src/services/emailEvents.ts:175-196` | SES `eventType` | `Delivery`, `Bounce`, `Complaint` | no `default` arm - but the union is closed upstream by `isEventType` (#41) | SAFE |
| 40 | `app/src/services/emailEvents.ts:187-189` | SES `bounceType` | `Permanent` | status still goes `undelivered`; only the suppression is skipped | SAFE - terminal either way |
| 41 | `app/src/services/sesNotifications.ts:100-102`, `:166-190` | `eventType` / `notificationType` | `Bounce`, `Complaint`, `Delivery`; `Received` | `{ kind: 'ignored', reason }` - never throws | SAFE |
| 42 | `app/src/services/sesNotifications.ts:90-93` (`mapSpamVerdict`) and `:95-98` (`mapVirusVerdict`) | SES receipt verdict `status` | spam: `PASS`/`FAIL`/`GRAY`; virus: `PASS`/`FAIL` | **`undefined`** -> `services/inboundEmail.ts:603` and `:642` do NOT quarantine -> the mail is THREADED | NOTE - **fail-open**. SES also emits `PROCESSING_FAILED`; on that value a virus-scan-failed message is delivered to the thread |
| 43 | `app/src/adapters/groupConversations.ts:494-497`, `:715-733` | Twilio Conversations error `code` / HTTP `status` | `50353`, `409`, `20404`, `50513` | rethrow - terminal | SAFE |
| 44 | `app/src/adapters/groupConversations.ts:589-591`, `:609-611`, `:642-644` | `status` 404 / `code` 20404 on delete/remove | those two | rethrow | SAFE - "already gone is success" is deliberate (:144-145) |
| 45 | `app/src/jobs/groupRail.ts:60-84` | `ensureGroupRail` result `status` (our own union) | `failed`, `unavailable` | log INFO "completed" | SAFE |
| 46 | `app/src/adapters/webPush.ts:60-61`, `:156-161` | push-service HTTP `statusCode` | `404`, `410` -> `gone` (prune) | rethrow, handled by `services/pushService.ts:217`/`:245`/`:267` | SAFE |
| 47 | `app/src/adapters/cloudwatch.ts:473-478` | CloudWatch alarm `StateValue` | `OK`, `ALARM` | `INSUFFICIENT_DATA` | SAFE |
| 48 | `app/src/adapters/cloudwatch.ts:749-762` | Logs Insights query `status` | `Complete`; `Failed`/`Cancelled`/`Timeout` -> throw | keep polling - **non-terminal**, but capped by `INSIGHTS_MAX_POLLS` then throws (:770) | SAFE-BY-CAP |
| 49 | `app/src/services/mediaMirror.ts:78-85` | media-fetch HTTP `status` | `408`/`425`/`429`/5xx retryable | **permanent** (terminal) - the right polarity | SAFE |
| 50 | `app/src/adapters/mediaStore.ts:62-63`, `:217`, `:262` | S3 `Code` / `$metadata.httpStatusCode` | `InvalidRange`/`416`, `404` | rethrow | SAFE |
| 51 | `app/src/adapters/extraction.ts:282-313` | Anthropic `stop_reason` | `refusal`, `max_tokens` | falls to the content/parse arms, each returning a terminal `ok:false` | SAFE |
| 52 | `app/src/adapters/messaging.ts:1020-1026`, `:1085-1091`, `:1105-1110` | HTTP `res.status` on media/recording fetch | non-2xx -> `MediaFetchError` carrying the status | terminal throw | SAFE |

Counts: **16 in-region, 7 fenced (`twilio.ts`), 29 out-of-region = 52 sites.**

## EXPOSED candidates

Provisional only. Slice 6 decides disposition; the two fan-out throws are
already excepted in advance by spec Sec 9 + D12.

1. `app/src/jobs/broadcastFanOut.ts:459` - IN-REGION. The unknown-send-error
   `throw` leaves the recipient `queued`, exits the recipient loop, and never
   finalizes the broadcast. **D12: FILED, NOT FIXED** in this branch
   (`throw-for-redelivery-defeated-by-job-marker`).
2. `app/src/jobs/relayFanOut.ts:904` - IN-REGION. Same shape, relay side.
   **D12: FILED, NOT FIXED.**
3. `app/src/services/groupRail.ts:259-262` - IN-REGION. `isDeadRailState`
   enumerates `closed`/`failed` and defaults every other Conversations `state`
   (and `undefined`) to "still works". Named as a live sweep hit by plan slice 6;
   its disposition flips on whether slice 4 has landed.
4. `app/src/adapters/messaging.ts:545-547` - OUT-OF-REGION, and the ROOT of the
   whole class. `mapTwilioStatus`'s `default: return 'queued'` is a non-terminal
   default on the raw `MessageStatus` enum, by its own comment applied to
   "anything new Twilio adds".
5. `app/src/routes/webhooks/twilio.ts:2359`, `:2470` - FENCED. Inherits #4 at the
   two highest-traffic call sites. Audit-only: FILE, never fix.
6. `app/src/routes/webhooks/voice.ts:1631-1637` - OUT-OF-REGION. An unmodeled
   `CallStatus`/`DialCallStatus` is acked and makes **no change**, leaving the
   call row non-terminal. Closest structural match to the 2026-08-16 incident
   still unpatched.

Near-miss, recorded so slice 6 can rule on it rather than rediscover it:
`app/src/services/groupReceipts.ts:546-551` (#32) drops an unmapped Conversations
status and leaves the slot `queued`. It is deliberate, ERROR-logged, and covered
by the staleness alarm - the reason it is NOTE and not EXPOSED.

## Confirmations requested

**The spec's zero-hit claim holds, and is stronger than stated.**

```
$ cd W:/tmp/retry-counter-durable/app/src && grep -rn "!== 'success'" .
(no output, exit 1)

$ cd W:/tmp/retry-counter-durable/app/src && grep -rn "'success'" .
(no output, exit 1)
```

`grep -n "'success'"` returns **zero hits in all of `app/src`** - not merely zero
`!== 'success'` comparisons. The token `success` appears only inside prose
comments and identifiers (`successful`, `firstExecution`, `'suggestion_replaced'`
and friends); there is no `'success'` STRING LITERAL anywhere in `app/src`. The
literal-grep half of the anchor issue's suggested sweep therefore could never
have found anything, which is exactly why Sec 9 re-bases the sweep on the
non-terminal-default shape instead.

**`jobs.ts` mints `jobId` once, at enqueue.** Current line is
`app/src/jobs/jobs.ts:188` (plan cited ~:189):

```
    jobId: randomUUID(),
```

inside `buildEnvelope` (`:164`), called only from `enqueue` (`:116`) and
`enqueueImmediate` (`:159`). Stronger still: `dispatchJob`'s envelope repair
returns a COMPLETE envelope untouched at `:262` and only mints a fresh id
(`:269`) for a legacy/incomplete envelope. A redelivery of a complete envelope
therefore carries the SAME `jobId`, and the per-`jobId` execution marker
suppresses it.

**`retrySend.ts` states the semantics correctly.** Current lines
`app/src/jobs/retrySend.ts:122-128` (plan cited ~:122-128 - unchanged):

```
    // Execution guard (M1.2): SQS is at-least-once - a DeleteMessage
    // failure, visibility overrun, or SIGTERM mid-flight redelivers this
    // job, and re-running it would TEXT THE HUMAN AGAIN. The envelope's
    // jobId (stable across redeliveries; dispatchJob stamps it into the
    // context) is conditionally marked as executed BEFORE the provider
    // send; a duplicate delivery resolves successfully so the consumer
    // deletes the message instead of DLQ-cycling it.
```

"stable across redeliveries" is the correct reading and matches `jobs.ts:188`.

**The two FALSE comments (comment-only fix, plan slice 6).** Both claim the
opposite of the above.

- `app/src/jobs/broadcastFanOut.ts:456-458` (unchanged from the plan's
  citation). Line :457 carries the false clause
  "a fresh jobId via the visibility timeout"; the `throw err` is at **:459**.
- `app/src/jobs/relayFanOut.ts:901-903` (the plan cited `:532-534` - **the file
  moved, this is the current location**). Line :903 carries the false clause
  "the redelivery is a fresh jobId via the visibility timeout"; the `throw err`
  is at **:904**.

Both are inside the regions slices 2 and 3 edit, so the correction is in-region
and comment-only. The `throw` itself stays (D12).
