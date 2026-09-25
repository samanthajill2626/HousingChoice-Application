# Retry send window - design

Date: 2026-09-24. Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`,
cut from `main` @`685f2ede`. Status: DRAFT 2 - after adversarial review round 1
(`docs/superpowers/reviews/2026-09-24-retry-send-window/spec-review-r1-adjudications.md`).

| sev | issue | this branch |
| --- | --- | --- |
| low | `group-text-30003-leg-retry-promise-unverified` | **closes** |
| - | (unfiled) a late 30003 re-sends hours- or days-old content | **closes** - the ruling itself |
| - | (unfiled) a manual Retry during an automatic retry's wait texts the member twice | **narrows** (section 9) |
| - | (unfiled) on manual-mode threads the screen promises a retry that is always refused | **closes** |
| low | `quiet-hours-ungated-automated-paths`, item 3 | annotate: automatic retries now end 15 minutes after the send |
| low | `relay-retry-stranded-claim-window` | unaffected |

This document states DECISIONS and INVARIANTS. Mechanics - control flow, where a
line goes, test code - belong to the plan. Records for this mission, including the
research that shaped it, are in `docs/superpowers/reviews/2026-09-24-retry-send-window/`.

## 0. The rulings this implements

Recorded in `docs/superpowers/reviews/2026-09-24-retry-send-window/rulings.md`.
Cameron's ruling on relay-30003 open question Q4, as recorded on `main`
@`cd8e8ddd`: "nothing re-sends a text more than 15 minutes after the original
went out ... A declined retry shows as a plain failed attempt. Alarm thresholds
unchanged." His brainstorm answers of the same day: the window measures when a
retry GOES OUT, not when the failure arrives; the number was left to the planner
(15 chosen); the manual Retry button is hidden while an automatic retry is
scheduled and the server refuses a manual retry during that wait; native group
text is in scope.

## 1. The invariant

**No automatic retry of a carrier-30003 failure is handed to the send path more
than 15 minutes after the original message went out, and the screen promises a
retry only after one has actually been scheduled - never more than
`RETRY_PROMISE_GRACE_MS` past its due time.**

"Automatic retry" means the two machine-initiated resend paths: the relay (masked
group) retry ladder and the one-to-one `messaging.retrySend` chain. A staff member
pressing Retry is a new human send; the window never limits it, and it starts a
window of its own. The one allowance: after the last gate, a relay send can wait
on the send path's own throttle (section 9).

## 2. What exists today

- **Relay ladder.** A 30003 status callback on a relay leg claims a retry in the
  webhook (`app/src/routes/webhooks/twilio.ts:2678-2907`) and schedules
  `relay.retryLeg` 60, 120 or 240 seconds later (`app/src/lib/relayRetryClaim.ts:13-18`,
  `app/src/jobs/relayRetryLeg.ts:214-234`), at most three rungs. Neither the claim
  nor the job looks at how old the message is.
- **One-to-one chain.** The webhook's 30003 arm (`twilio.ts:3350-3369`) enqueues
  `messaging.retrySend` on the same backoff, capped at three
  (`app/src/jobs/retrySend.ts:36-42`). No age check either.
- **Why age matters.** Carriers hold a text for a powered-off phone for 24-72 hours
  (Verizon: up to 5 days) and may then give up. A late 30003 today re-sends
  hours- or days-old content, out of context in the thread.
- **Manual-mode threads.** Every automated send is refused when a conversation is
  in manual mode (`app/src/services/sendMessage.ts:348-349`), including the
  automatic retry; the job logs WARN and stops (`retrySend.ts:209-216`). The Quo
  import writes `ai_mode = manual` on every conversation it creates
  (`app/src/lib/import/apply.ts:1093`, `:1107`), and the breaker also switches a
  conversation to manual (`sendMessage.ts:352`). On those threads the arm still
  enqueues a retry that is certain to be refused.
- **The promise.** The one-to-one reason reads "Phone unreachable - will retry"
  for EVERY 30003, keyed by the code alone
  (`dashboard/src/routes/contact/deliveryStatus.ts:778`): false after the third
  retry fails, false on manual-mode threads, and false for native group texts,
  where no retry exists. On the broadcast result badge
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`) it reflects that a
  broadcast recipient's 30003 IS retried, but the badge never learns the outcome.
- **The double send.** The manual Retry button shows on any failed one-to-one
  bubble (`dashboard/src/routes/contact/Timeline.tsx:1341`), including during an
  automatic retry's wait, and the retry route checks only that the message failed
  (`app/src/routes/api.ts:1592`). Pressing it mid-wait texts the member twice.
- **Lineage after the send.** The one-to-one retry job annotates `retry_of` and
  `retry_attempt` AFTER the send (`retrySend.ts:221-229`), an accepted race: a
  fast 30003 on the retry can read no `retry_attempt` and reset the cap.

## 3. Decisions

**D1. The window.** `RETRY_SEND_WINDOW_MS` = 15 minutes (Cameron left the number
to the planner; 15 is the same span as the dashboard's existing "not confirmed"
clock, `STALE_SENT_AFTER_MS`). A normal ladder - first failure within a minute,
then waits of 1, 2 and 4 minutes - finishes by about minute 8, so the window cuts
off only failures that arrive late.

**D2. The origin - what "the original went out" means.**
- One-to-one: the original message's provider timestamp (`provider_ts`: Twilio's
  dateCreated for the send, also the prefix of its `tsMsgId`,
  `app/src/adapters/messaging.ts:745`). `retry_of` points only at the previous
  attempt, so every automatic retry row records `retry_window_start` = the chain's
  origin, and attempts 2 and 3 still measure from the first send.
- Relay: the member's ORIGINAL leg send time - the member slot's `sentAt` (Twilio's
  dateCreated, `app/src/jobs/relayFanOut.ts:1457`). NOT the root row's timestamp:
  that is receipt or compose time, and for a message held while a group connects
  it can precede the real send by a long time (`app/src/routes/api.ts:1710`).
  Carried forward on every retry row as `relay_retry_window_start`. A retry row
  WITHOUT it (claimed before this deploy) is never re-derived from its own slot -
  that would restart the window; D5 applies instead.
- A manual Retry never copies `retry_window_start`: a human chose to send now.

**D3. Check when scheduling, with the grace.** Before scheduling a rung, compute
when it would send (now plus that rung's resolved backoff). Schedule it only if
`send time + RETRY_JOB_GRACE_MS <= origin + RETRY_SEND_WINDOW_MS` (grace = 60
seconds, absorbing queue delay). Otherwise schedule nothing.
- Relay: a new claim outcome, `window_closed`, decided after the cap check and
  before the claim's append (`twilio.ts`, between 2763 and 2781). Before declaring
  it, the claim probes the rung's deterministic pointer (`relayRetryProviderSid`,
  `relayRetryClaim.ts:33-35`): if that rung already exists, the outcome is
  `already_claimed` (WARN), not a dead end - a duplicate callback near the edge
  must not log a false ERROR. A true decline leaves the member's slot exactly as
  `cap_exhausted` does: terminal on 30003, no new retry row, no enqueue, no claim
  SSE.
- One-to-one: see D3a for the order; a window decline schedules nothing and logs
  (D9), mirroring the exhausted-retries branch (`twilio.ts:3353-3361`).

**D3a. The one-to-one arm schedules only a retry that can run.** In order:
1. A `group_text` conversation never schedules (D11).
2. If an automated send to this conversation would be refused right now - the
   kill switch, an opt-out, or manual mode, previewed with the existing
   `evaluateScheduledSendSuppression` (`app/src/services/scheduledSendSuppression.ts:52-68`)
   - schedule nothing, stamp nothing, and log WARN (the job's refusal level today).
   The bubble shows the plain failure with a live Retry button: on manual-mode
   threads this keeps today's only working retry path.
3. The existing cap: exhausted retries log ERROR, as today.
4. The window (D3): a decline logs ERROR (D9).
5. Otherwise enqueue, then stamp (D7).
The breaker and a soft-deleted contact are not previewable (the preview omits them
by design); a retry refused for those at send time is a section 9 residual.

**D4. Check again right before sending.** The job checks
`now <= origin + RETRY_SEND_WINDOW_MS`, strictly (the grace was spent at
scheduling).
- Relay job: the check is the LAST gate before the send (after the opt-out gate)
  and closes the rung with a new close code, `retry_window_closed`, through the
  pre-send refusal path (`refuseGate`). The transient re-enqueue
  (`relayRetryLeg.ts:643-646`) re-checks and closes instead of re-enqueueing once
  past the window.
- One-to-one job: checks before `sendMessage` and ends the chain without sending.

**D5. A missing origin fails open.** A relay slot with no `sentAt`, or a retry row
without `relay_retry_window_start` (claimed before this deploy), skips the window
check and logs a WARN naming the gap. The new relay field is OPTIONAL in the job's
lineage check: that check throws after the execution marker is set, so a required
field would silently drop every rung claimed before the deploy. A one-to-one row
with no `retry_window_start` uses its own `provider_ts`.

**D6. Lineage is written with the row.** The one-to-one retry job passes
`retry_of`, `retry_attempt` and `retry_window_start` into the send, so they are
written when the row is appended (the `sendMessage` input and append path,
`app/src/services/sendMessage.ts:193-241`, `:398-428` ->
`app/src/repos/messagesRepo.ts:2265`), not annotated afterwards. This closes the
race in section 2, which now matters more: a lost origin would restart the window.

**D7. "A retry is scheduled" is recorded and pushed.** When the one-to-one arm
enqueues a retry successfully, it stamps the FAILED message with `retry_due_at` =
the retry's run time, by extending `annotateMessage`'s `MessageAnnotations`
(`messagesRepo.ts:1173-1177`), and then emits `message.persisted` for that message.
The transition's own emit (`twilio.ts:3291-3301`) fires before the arm runs, so
without a second emit an open screen would learn of the stamp only by luck. Order:
enqueue, stamp, emit. A lost stamp leaves no promise for a retry that happens
anyway (honest); a stamp before a failed enqueue would promise a retry that never
comes. The stamp reaches the dashboard through the contact-timeline projection
(`app/src/routes/contactTimeline.ts:406-463`) and the dashboard type
(`dashboard/src/api/types.ts:2479`).

**D8. What the screen says.**
- **The rule, for every surface:** a 30003 promises a retry ONLY while the failed
  message carries a live `retry_due_at`, never from the retry count. After this
  branch a 30003 declined by the window or by D3a still has "retries remaining"
  by count while no retry is scheduled.
- The base 30003 reason drops the promise: "Phone unreachable" (the
  `(error 30003)` tail is appended as today). That is what shows on native
  group-text legs, rollups and message rows, and on a one-to-one bubble whose
  retries ran out, was declined, or sits on a manual-mode thread.
- A one-to-one bubble adds the promise - "Phone unreachable - will retry" - only
  while its `retry_due_at` is live: the bubble clock is before
  `retry_due_at + RETRY_PROMISE_GRACE_MS` (2 minutes). When the retry lands, its
  own bubble replaces the failed one, as today (`retry_of`).
- The promise expires on screen without a reload: a one-to-one bubble with a live
  promise joins the Timeline's existing ticker (today one-to-one bubbles never
  tick, `Timeline.tsx:859-899`, pinned by `Timeline.ticker.test.tsx:412-418`), and
  its live test reuses the Timeline's clock-skew bound (`Timeline.tsx:791-797`),
  so a slow browser clock cannot hold the promise open. Expiry lands within the
  ticker's 60 seconds.
- The share results row (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`)
  follows the same rule. That row's copy table belongs to `feat/share-skip-fix`
  (section 5); this branch owns only the rule it must follow.
- New and touched copy is ASCII (the current string's em dash becomes a hyphen).
- Relay: per the ruling, every declined retry shows as a plain failed attempt. At
  rung 1 a claim-time decline leaves no rung, and the leg reads "Phone
  unreachable (error 30003)". At rungs 2 and 3 the leg goes terminal through the
  join, as at `cap_exhausted` (`dashboard/src/routes/contact/relayRetryJoin.ts:405-415`).
  A job-time decline closes the rung with `retry_window_closed` (kept for data and
  logs), whose copy in `INTERNAL_CODE_REASONS` (`deliveryStatus.ts:913-935`) is
  "Phone unreachable (error 30003)" - the same words as a claim-time decline.

**D9. Logging.** Every window decline is a dead end - the member never got the
text - so it logs one ERROR, like `cap_exhausted` and the exhausted-retries line
today:
- relay claim: the `window_closed` outcome, ERROR through
  `isTerminalRelayLegFailure` (not in its WARN set);
- relay job: the `retry_window_closed` close, ERROR;
- one-to-one arm and job: one ERROR line each, naming `window_closed`.
A D3a skip is a WARN (a by-design refusal, the level the job logs one at today).
A missing origin (D5) is a WARN. The per-callback `delivery_failed` marker and
every alarm threshold are unchanged.

**D10. The manual Retry guard** (Cameron's option 1, `rulings.md`).
- Screen: the Retry button is hidden while the one-to-one promise shows (D8).
- Server: the retry route refuses with 409 `retry_pending` while
  `retry_due_at + RETRY_PROMISE_GRACE_MS` is in the future (after its not-failed
  check, `api.ts:1592-1595`). The dashboard maps `retry_pending` to "A retry is
  already scheduled for this message." (every unmapped 409 reads the generic
  "Couldn't send" today, `Timeline.tsx:86-131`).
- `RETRY_PROMISE_GRACE_MS` is one value, mirrored in the dashboard and pinned by a
  test (the media-type mirror precedent,
  `dashboard/src/routes/contact/mediaTypeMirror.test.ts`).
- Nothing else. The guard is time-based; section 9 names what it leaves.

**D11. Native group text.** No retry exists for a native group text. The one-to-one
arm refuses to schedule one UNCONDITIONALLY for a `group_text` conversation (the
conversation is read anyway for D3a), logging WARN. Whether a classic callback
can reach that arm for a group text is live Twilio behavior no build can settle:
the repo asserts both sides (`app/src/services/groupReceipts.ts:3-10` against
`twilio.ts:3422-3429`, `:3477-3479`), and a synthetic test drives the arm with a
group row (`app/test/twilioStatusWebhook.test.ts:1420-1463`). The false promise on
screen is copy: D8's base wording removes it from the leg, the rollup and the
message row. The tests that pin the carve-out (`deliveryStatus.test.ts:419` and
`:738`, `Timeline.delivery.test.tsx:516` and `:577`) are INVERTED, not deleted.

**D12. Comments that now lie are corrected.**
- `deliveryStatus.ts:824-858`: the "NO RELAY RETRY EXISTS" rationale, written
  before the relay ladder, and "the 1:1 entry above stays byte-for-byte ... a 1:1
  30003 retry genuinely does send".
- `twilio.ts:316-341` (the 30003 carve-out rationale, "the one path where the
  promise holds"), and `:3422-3429` and `:3477-3479` (native group texts "ARE
  REACHABLE HERE"), reworded to D11's position.
- `Timeline.tsx:973-979` and `:1272-1275` (the group-text "retry is real" notes).
- D6 makes these false: `sendMessage.ts:234-240`, `messagesRepo.ts:725-731` and
  `:2262-2265`, `retrySend.ts:9-10` and `:221-225`.
- Test and doc comments: `deliveryStatus.test.ts:721-737`,
  `Timeline.delivery.test.tsx:460-465`, `:509-515`, `:570-576`,
  `StatChips.test.tsx:120-127`, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-22`,
  `e2e/support/selectors.md:49`.

**D13. Test seams and fixtures.**
- Unit tests inject the clock.
- A one-to-one retry backoff lane seam, `E2E_SEND_RETRY_BACKOFF_MS`, honored only
  when `JOBS_QUEUE_URL` is unset (the relay's `E2E_RELAY_RETRY_BACKOFF_MS` guard,
  `relayRetryLeg.ts:190-196`). share-skip-fix plans the same seam; whichever lands
  first builds it and the other reuses it.
- If an e2e needs a short window, `E2E_RETRY_SEND_WINDOW_MS` has the same guard,
  and its lane value must exceed BOTH lanes' ladders (the relay spec's 10-second
  rungs and the one-to-one lane backoff).
- Fixtures: one-to-one fixtures with fixed past `provider_ts`
  (`app/test/twilioStatusWebhook.test.ts:59`) move to realistic times. Relay
  fixtures without a slot `sentAt` (`app/test/relayRetryClaim.webhook.test.ts:157-161`,
  `:174-178`) pass through D5 unchanged; the relay window tests need NEW fixtures
  with a slot `sentAt`.

## 4. Every surface the plan must cover

The plan enumerates each as a task or a watch item (research sweep plus review
round 1):

- **Writers of automatic retries:** relay claim and enqueue (`twilio.ts:2781`,
  `:2842`); relay send and transient re-enqueue (`relayRetryLeg.ts:575`,
  `:643-646`); one-to-one enqueue (`twilio.ts:3364`); one-to-one send and lineage
  (`retrySend.ts:200-229`), through the `sendMessage` input and append path
  (`sendMessage.ts:193-241`, `:398-428`); handler registration
  (`app/src/jobs/registerHandlers.ts:47`, `:60`); the lane backoff override
  (`scripts/e2e-session.mjs:272`). Manual: the route's checks and append
  (`api.ts:1571-1595`, `:1651`).
- **Where the new checks land:** the relay claim (`twilio.ts:2763-2781`), the relay
  job's gates (`relayRetryLeg.ts:491-555`), the one-to-one arm (`twilio.ts:3350-3369`),
  the one-to-one job's read of the original (`retrySend.ts:112-120`).
- **Readers of retry lineage:** server `twilio.ts:2757`, `:2761`, `:2776`, `:2825`,
  `:3129`, `:3353`; `relayRetryLeg.ts:268-292`, `:372`; `messagesRepo.ts:2265-2284`,
  `:2335`, `:2912-2918`; `contactTimeline.ts:442`. Dashboard `types.ts:2308-2315`,
  `:2494`, `:2509-2515`; `useRelayThread.ts:101-142`; `relayRetryJoin.ts:135-164`,
  `:453`; `Timeline.tsx:885`, `:1077`, `:1975-1984`, `:2004-2019`.
- **Readers of the 30003 copy:** `deliveryStatus.ts:778` via the Timeline chip,
  reason, rollup, row and spoken summary; EmailCard; `DeliveryBadge.tsx:31`;
  StatChips. Tests: those in D11, plus `StatChips.test.tsx:129`,
  `Timeline.email.test.tsx:114`, `Timeline.delivery.test.tsx:528-536` and `:593`.
- **Vocabulary:** the `RelayRetryCloseCode` union (`relayRetryLeg.ts:91-97`) and its
  gate-case table (`app/test/relayRetryLeg.test.ts:307` onward) gain
  `retry_window_closed`; the `RelayRetryClaimOutcome` union's exhaustive test
  (`app/test/relayRetryClaim.test.ts:51-88`) moves from thirteen values to
  fourteen; the close-code copy test (`deliveryStatus.test.ts:1648-1668`) gains the
  new code; `e2e/support/selectors.md:49` documents the prose family.
- **Test doubles:** the harness copy of `annotateMessage`
  (`app/test/helpers/twilioWebhookHarness.ts:1338`) and the harness fake `append`,
  an explicit field allowlist (`:1081-1152`) that would silently drop the new
  append-time fields and let a "carried origin" test pass vacuously through D5.
- **Seeds and dev seams:** none write retry fields today (research sweep); the
  plan confirms none are added.

## 5. Concurrent work

Both branches below are at the spec stage in other sessions and are moving; the
plan re-reads them before it is written. Whichever branch lands second carries
each coupling named here.

- **`feat/share-skip-fix`** (v5 @`3a6a1a06`, at its human gate):
  - It edits the same one-to-one retry send call (`retrySend.ts:200-207`) and the
    same retry route (`api.ts:1564-1661`): both retries will carry the share, so
    `retrySend.ts` and `api.ts` merge textually with D6 and D10.
  - Copy conflict on the share results row. Its table keeps "Phone unreachable -
    will retry" for "30003 with retries remaining" and adds "Phone unreachable -
    retries exhausted". After this branch, "retries remaining" by count no longer
    means a retry is scheduled (D3, D3a), so that derivation must switch to D8's
    rule - a live `retry_due_at`. The row's wording stays share-skip-fix's.
  - It plans the same one-to-one backoff seam as D13.
  - It accepts the manual double send as today's behavior; D10 narrows it.
  - Its automation switch (turning manual-mode conversations back on) changes how
    many threads D3a skips. D3a reads the live switch, so both orders hold.
- **`feat/send-outcome-reconcile`** (revision 2 @`513e0717`) plans edits to
  `relayRetryLeg.ts`, `retrySend.ts`, `messagesRepo.ts`, `sendMessage.ts` and
  `deliveryStatus.ts`. Three couplings:
  1. Its reconcile can re-drive a relay rung later. That passes through D4's
     job-time check, so the window bounds it.
  2. Its one-to-one "adopt" path appends a retry row with the lineage the job
     would have annotated. That append must carry `retry_window_start` (D2, D6).
  3. It re-enqueues the one-to-one rung once on `never_sent` or `retryable` (a
     `deferred` flag). That is a second one-to-one scheduling site: it must apply
     D3's check and refresh `retry_due_at`, or the promise lapses and the Retry
     button returns while an automatic send is still pending.

## 6. Test intentions

1. The window helper: scheduling allowed only with the grace to spare; the job's
   strict boundary at exactly 15 minutes.
2. Relay claim: a 30003 whose rung send plus grace lands after `sentAt + 15 min`
   declines with `window_closed` - ERROR, no retry row, no enqueue, slot
   unchanged; the same situation with the rung already claimed yields
   `already_claimed` (WARN); inside the window it claims as today; rung 2's claim
   measures from the carried origin (with the harness append preserving the new
   field).
3. Relay job: past the window it closes with `retry_window_closed` - ERROR, one
   SSE for the root, no send, and the leg reads "Phone unreachable (error 30003)";
   a transient pass past the window closes instead of re-enqueueing; a pre-deploy
   rung without the field still runs (WARN).
4. One-to-one arm: `group_text` schedules nothing (WARN); a manual-mode, opted-out
   or kill-switched conversation schedules nothing and stamps nothing (WARN);
   exhausted retries log ERROR as today; past the window it declines (ERROR, no
   enqueue, no stamp); inside it enqueues, stamps `retry_due_at` and emits; a
   failed enqueue leaves no stamp.
5. One-to-one job: past the window it ends without sending; the new retry row
   carries `retry_of`, `retry_attempt` and `retry_window_start` at append, with
   nothing annotated afterwards.
6. Manual route: 409 `retry_pending` before `retry_due_at + grace`, allowed after;
   a manual retry row has no `retry_window_start`.
7. Dashboard: no promise in the base 30003 copy on every listed surface; a
   one-to-one bubble with a live `retry_due_at` shows the promise and no Retry
   button; a bubble without one (manual mode, declined, exhausted) shows the plain
   failure and the Retry button; the ticker arms while the promise is live, the
   promise disappears after `retry_due_at + grace` without a reload, and a skewed
   clock cannot hold it open; `retry_pending` maps to its message; the native
   group-text tests are inverted; `retry_window_closed` has its copy; the mirrored
   grace constant is pinned.
8. E2E, using the one-to-one backoff seam: a 30003 on a one-to-one text shows
   "Phone unreachable - will retry" with no Retry button, then the retry's own
   bubble replaces it (no one-to-one retry spec exists today). The relay 30003 spec
   still passes.

## 7. For Cameron at review

- **Copy to approve:** "Phone unreachable" (no promise; the base 30003 wording
  everywhere), "Phone unreachable - will retry" (a one-to-one bubble while a retry
  is scheduled), and "A retry is already scheduled for this message." (a stale
  tab's manual Retry).
- **One rule across two specs:** the share results row's "will retry" follows D8
  (a scheduled retry), not share-skip-fix's retry count (section 5).
- **Sequencing** with `feat/share-skip-fix` and `feat/send-outcome-reconcile`
  (section 5): which lands first.

## 8. Out of scope

- A real retry for native group texts.
- Alarm thresholds (Q4's original question) and a manual retry for relay legs.
- Polling for sent-but-unconfirmed legs.
- The share results row's copy table (share-skip-fix's surface; D8 sets only the
  rule it follows).
- The relay stranded-claim window (`relay-retry-stranded-claim-window`, low).

## 9. Residuals

- The relay send waits on an unbounded token bucket after the job's last gate
  (`relayFanOut.ts:1360`); a long throttle could push a send past the window.
- A retry refused at send time for a reason D3a cannot preview (the breaker, a
  soft-deleted contact) keeps its promise until `retry_due_at + grace`.
- The manual guard is time-based. A Retry pressed in the second or so before the
  promise reaches the screen, or after an expired promise while the automatic job
  is running late, can still double-send - today's behavior, narrowed to those
  windows. A stale tab can still retry an original an automatic retry already
  replaced (the screen hides replaced bubbles).
- The promise can linger up to 60 seconds past `retry_due_at + grace` (ticker
  granularity).
