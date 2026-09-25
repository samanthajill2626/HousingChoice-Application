# Retry send window - design

Date: 2026-09-24. Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`,
cut from `main` @`685f2ede`. Status: DRAFT 1 - for adversarial review, then
Cameron's review.

Anchor: Cameron's ruling on relay-30003 open question Q4
(`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/founder-rulings-2026-09-24.md`)
and his brainstorm answers of 2026-09-24.

| sev | issue | this branch |
| --- | --- | --- |
| low | `group-text-30003-leg-retry-promise-unverified` | **closes** |
| - | (unfiled) a late 30003 re-sends hours- or days-old content | **closes** - the ruling itself |
| - | (unfiled) a manual Retry during an automatic retry's wait texts the member twice | **closes** |
| low | `quiet-hours-ungated-automated-paths`, item 3 | annotate: automatic retries now end 15 minutes after the send |
| low | `relay-retry-stranded-claim-window` | unaffected |

This document states DECISIONS and INVARIANTS. Mechanics - control flow, where a
line goes, test code - belong to the plan. Research that shaped it is recorded in
`docs/superpowers/reviews/2026-09-24-retry-send-window/`.

## 1. The invariant

**No automatic retry of a carrier-30003 failure is sent more than 15 minutes after
the original message went out, and the screen promises a retry only while one is
actually scheduled.**

"Automatic retry" means the two machine-initiated resend paths: the relay (masked
group) retry ladder and the one-to-one `messaging.retrySend` chain. A staff member
pressing Retry is a new human send; the window never limits it, and it starts a
window of its own.

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
- **The promise.** The one-to-one reason reads "Phone unreachable - will retry" for
  EVERY 30003, keyed by the code alone (`dashboard/src/routes/contact/deliveryStatus.ts:778`).
  It is false after the third retry fails, false on a broadcast result badge
  (a retry drops the broadcast id), and false for native group texts, where no
  retry exists.
- **The double send.** The manual Retry button shows on any failed one-to-one
  bubble (`dashboard/src/routes/contact/Timeline.tsx:1341`), including during an
  automatic retry's wait, and the retry route checks only that the message failed
  (`app/src/routes/api.ts:1592`). Pressing it mid-wait texts the member twice.
- **Lineage after the send.** The one-to-one retry job annotates `retry_of` and
  `retry_attempt` AFTER the send (`retrySend.ts:221-229`), an accepted race: a fast
  30003 on the retry can read no `retry_attempt` and reset the cap.

## 3. Decisions

**D1. The window.** `RETRY_SEND_WINDOW_MS` = 15 minutes. An automatic retry may be
sent only while `now <= origin + RETRY_SEND_WINDOW_MS` (plus D4's job grace).
Cameron left the number open; 15 is the same span as the dashboard's existing
"not confirmed" clock (`STALE_SENT_AFTER_MS`). A normal ladder - first failure
within a minute, then waits of 1, 2 and 4 minutes - finishes by about minute 8, so
the window cuts off only failures that arrive late.

**D2. The origin - what "the original went out" means.**
- One-to-one: the original message's provider timestamp (`provider_ts`: Twilio's
  dateCreated for the send, also the prefix of its `tsMsgId`,
  `app/src/adapters/messaging.ts:745`). `retry_of` points only at the previous
  attempt, so every automatic retry row records `retry_window_start` = the chain's
  origin, and attempts 2 and 3 still measure from the first send.
- Relay: the member's ORIGINAL leg send time - the member slot's `sentAt` (Twilio's
  dateCreated, `app/src/jobs/relayFanOut.ts:1457`). NOT the root row's timestamp:
  that is receipt or compose time, and for a message held while a group connects it
  can precede the real send by a long time (`app/src/routes/api.ts:1710`). Carried
  forward on every retry row as `relay_retry_window_start`, the way
  `relay_retry_origin_direction` already is (`twilio.ts:2824-2825`).
- A manual Retry never copies `retry_window_start`: a human chose to send now.

**D3. Check when scheduling.** Before scheduling a rung, compute when it would send
(now plus that rung's resolved backoff). If that lands after the window, schedule
nothing.
- Relay: a new claim outcome, `window_closed`, decided after the cap check and
  before the claim's append (`twilio.ts`, between 2763 and 2781). The member's slot
  is left exactly as `cap_exhausted` leaves it: terminal on 30003, no retry row, no
  enqueue, no claim SSE.
- One-to-one: the 30003 arm schedules nothing and logs (D9), mirroring the
  exhausted-retries branch (`twilio.ts:3353-3361`).

**D4. Check again right before sending.** The job re-checks
`now <= origin + RETRY_SEND_WINDOW_MS + RETRY_JOB_GRACE_MS`, with a 60-second grace
that absorbs queue jitter for a rung scheduled at the edge.
- Relay job: the check is the LAST gate before the send (after the opt-out gate)
  and closes the rung with a new close code, `retry_window_closed`, through the
  pre-send refusal path (`refuseGate`). The transient re-enqueue
  (`relayRetryLeg.ts:643-646`) re-checks and closes instead of re-enqueueing once
  past the window.
- One-to-one job: checks before `sendMessage` and ends the chain without sending.

**D5. A missing origin fails open.** A relay slot with no `sentAt`, or a retry row
without the new lineage field (a rung claimed before this deploy), skips the window
check and logs a WARN naming the gap. The new relay field is OPTIONAL in the job's
lineage check: that check throws after the execution marker is set, so a required
field would silently drop every rung claimed before the deploy. A one-to-one row
with no `retry_window_start` uses its own `provider_ts`.

**D6. Lineage is written with the row.** The one-to-one retry job passes
`retry_of`, `retry_attempt` and `retry_window_start` into the send, so they are
written when the row is appended (the existing `retryOf` input path,
`app/src/services/sendMessage.ts` -> `app/src/repos/messagesRepo.ts:2265`), not
annotated afterwards. This closes the race in section 2, which now matters more: a
lost origin would restart the window.

**D7. "A retry is scheduled" is recorded.** When the one-to-one 30003 arm enqueues
a retry successfully, it stamps the FAILED message with `retry_due_at` = the
retry's run time, by extending `annotateMessage`'s `MessageAnnotations`
(`messagesRepo.ts:1173-1177`). Enqueue first, stamp second: a lost stamp leaves no
promise for a retry that happens anyway (honest), while a stamp before a failed
enqueue would promise a retry that never comes. The stamp reaches the screen
through the contact-timeline projection (`app/src/routes/contactTimeline.ts:406-463`)
and the dashboard type (`dashboard/src/api/types.ts:2479`), and it must reach an
open screen without a reload.

**D8. What the screen says.**
- The base 30003 reason drops the promise everywhere: "Phone unreachable" (the
  `(error 30003)` tail is appended as today). That is what shows on native
  group-text legs and message rows, on broadcast result badges
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`), on a one-to-one bubble
  whose retries ran out, and on a window-declined one.
- A one-to-one bubble adds the promise - "Phone unreachable - will retry" - only
  while it carries `retry_due_at` and the bubble clock is before
  `retry_due_at + RETRY_PROMISE_GRACE_MS` (2 minutes). When the retry lands, its
  own bubble replaces the failed one, as today (`retry_of`).
- The promise expires on screen without a reload: a one-to-one bubble with a live
  promise joins the Timeline's existing ticker. Today one-to-one bubbles never tick
  (`Timeline.tsx:859-899`, pinned by `Timeline.ticker.test.tsx:412-418`). Expiry is
  within the ticker's 60 seconds.
- New and touched copy is ASCII (the current string's em dash becomes a hyphen).
- Relay: a claim-time decline changes nothing on screen (no rung exists, and the
  leg already reads "Phone unreachable (error 30003)"). A job-time decline closes
  the rung with `retry_window_closed`; its copy in `INTERNAL_CODE_REASONS`
  (`deliveryStatus.ts:913-935`) is "Retry skipped - message too old" (see
  section 7).

**D9. Logging.** Every decline is a dead end - the member never got the text - so
it logs one ERROR, like `cap_exhausted` and the exhausted-retries line today:
- relay claim: the `window_closed` outcome, ERROR through
  `isTerminalRelayLegFailure` (not in its WARN set);
- relay job: the `retry_window_closed` close, ERROR;
- one-to-one arm and job: one ERROR line each, naming `window_closed`.
The per-callback `delivery_failed` marker and every alarm threshold are unchanged.
A missing origin (D5) is a WARN.

**D10. The manual Retry guard** (Cameron, 2026-09-24).
- Screen: the Retry button is hidden while the one-to-one promise shows.
- Server: the retry route refuses with 409 `retry_pending` while
  `retry_due_at + RETRY_PROMISE_GRACE_MS` is in the future (after its not-failed
  check). The dashboard maps `retry_pending` to "A retry is already scheduled for
  this message." (every unmapped 409 reads the generic "Couldn't send" today).
- The reverse race: when the route sends, it stamps the original with
  `manual_retry_at`, and the automatic job skips its send (WARN, chain ends) when
  its original carries that stamp. A manual Retry that beat the `retry_due_at`
  stamp can never be followed by an automatic one.
- `RETRY_PROMISE_GRACE_MS` is one value, mirrored in the dashboard and pinned by a
  test (the media-type mirror precedent).

**D11. Native group text.** No retry exists for a native group text, and the
classic 30003 arm is not believed reachable for one: Conversations receipts drive
those slots (`app/src/services/groupReceipts.ts:3-10`, `:448-458`), and group rows
carry no classic SID alias. UNVERIFIED - the build confirms it; if the arm IS
reachable for a `group_text` message, it must not enqueue there. The false promise
itself is copy: D8's base wording removes it from the leg, the rollup and the
message row. The tests that pin the carve-out
(`deliveryStatus.test.ts:419` and `:738`, `Timeline.delivery.test.tsx:516` and
`:577`) are INVERTED, not deleted.

**D12. Comments that now lie are corrected.** The "NO RELAY RETRY EXISTS"
rationale above `RELAY_ERROR_CODE_REASONS` (`deliveryStatus.ts:824-829`, written
before the relay ladder existed), the group-text "the retry is real" notes
(`Timeline.tsx:973-979`, `:1272-1275`), and the matching test comments.

**D13. Test seams.** Unit tests inject the clock. If an e2e needs a short window,
`E2E_RETRY_SEND_WINDOW_MS` is honored only when `JOBS_QUEUE_URL` is unset (the
`E2E_RELAY_RETRY_BACKOFF_MS` guard, `relayRetryLeg.ts:190-196`), and it must stay
above what the lane's relay retry spec needs. Existing fixtures that use fixed past
timestamps (`app/test/twilioStatusWebhook.test.ts:59`,
`app/test/relayRetryClaim.webhook.test.ts:66`, `:174`) move to realistic times;
fixtures without a slot `sentAt` keep passing through D5.

## 4. Every surface the plan must cover

The plan enumerates each as a task or a watch item (research sweep, 2026-09-24):

- **Writers of automatic retries:** relay claim and enqueue (`twilio.ts:2781`,
  `:2842`); relay send and transient re-enqueue (`relayRetryLeg.ts:575`,
  `:643-646`); one-to-one enqueue (`twilio.ts:3364`); one-to-one send and lineage
  (`retrySend.ts:200-229`); handler registration (`app/src/jobs/registerHandlers.ts:47`,
  `:60`); the lane backoff override (`scripts/e2e-session.mjs:272`). Manual:
  `api.ts:1651`.
- **Readers of retry lineage:** server `twilio.ts:2757`, `:2761`, `:2776`, `:2825`,
  `:3129`, `:3353`; `relayRetryLeg.ts:268-292`, `:372`; `messagesRepo.ts:2265-2284`,
  `:2335`, `:2912-2918`; `contactTimeline.ts:442`. Dashboard `types.ts:2308-2315`,
  `:2494`, `:2509-2515`; `useRelayThread.ts:101-142`; `relayRetryJoin.ts:135-164`,
  `:453`; `Timeline.tsx:885`, `:1077`, `:1975-1984`, `:2004-2019`.
- **Readers of the 30003 copy:** `deliveryStatus.ts:778` via the Timeline chip,
  reason, rollup, row and spoken summary; EmailCard; `DeliveryBadge.tsx:31`;
  StatChips. Tests: those in D11, plus `StatChips.test.tsx:129`,
  `Timeline.email.test.tsx:114`, `Timeline.delivery.test.tsx:528-536` and `:593`.
- **Test doubles:** the harness copy of `annotateMessage`
  (`app/test/helpers/twilioWebhookHarness.ts:1338`) changes with the real one; the
  `RelayRetryClaimOutcome` union's exhaustive test (`relayRetryClaim.test.ts:51-88`)
  moves from thirteen values to fourteen; the close-code copy test
  (`deliveryStatus.test.ts:1648-1668`) gains `retry_window_closed`.

## 5. Concurrent work

- **`feat/send-outcome-reconcile`** (another session, spec stage) plans edits to
  `relayRetryLeg.ts`, `retrySend.ts`, `messagesRepo.ts`, `sendMessage.ts` and
  `deliveryStatus.ts`. Two semantic couplings:
  1. Its reconcile job can re-drive a relay rung later. That passes through D4's
     job-time check, so the window bounds it.
  2. Its one-to-one "adopt" path appends a retry row "with the lineage the job
     would have annotated". That append must also carry `retry_window_start`
     (D2, D6).
  Whichever branch lands second carries the coupling.
- **`feat/share-skip-fix`** (another session, spec stage): its automation switch
  refuses the one-to-one automatic retry at send time (`sendMessage.ts:349`). That
  refusal comes after D7's stamp, and the promise expires at
  `retry_due_at + RETRY_PROMISE_GRACE_MS` (D8). Its edits to `twilio.ts`,
  `deliveryStatus.ts` and `contactTimeline.ts` are in other regions.

## 6. Test intentions

1. The window helper: the boundary at exactly 15 minutes, and the job grace.
2. Relay claim: a 30003 whose rung-1 send (now + backoff) lands after
   `sentAt + 15 min` declines with `window_closed` - ERROR, no retry row, no
   enqueue, slot unchanged; inside the window it claims as today; rung 2's claim
   measures from the carried origin.
3. Relay job: past the window plus grace it closes with `retry_window_closed` -
   ERROR, one SSE for the root, no send; a transient pass past the window closes
   instead of re-enqueueing; a pre-deploy rung without the field still runs (WARN).
4. One-to-one arm: past the window it declines - ERROR, no enqueue, no stamp;
   inside, it enqueues AND stamps `retry_due_at`; a failed enqueue leaves no stamp.
5. One-to-one job: past the window it ends without sending; it skips when
   `manual_retry_at` is set; the new retry row carries `retry_of`,
   `retry_attempt` and `retry_window_start` at append, with nothing annotated
   afterwards.
6. Manual route: 409 `retry_pending` before `retry_due_at + grace`, allowed after;
   it stamps `manual_retry_at`; a manual retry row has no `retry_window_start`.
7. Dashboard: no promise in the base 30003 copy on every listed surface; a
   one-to-one bubble with a live `retry_due_at` shows the promise and no Retry
   button; the ticker arms while the promise is live and the promise disappears
   after `retry_due_at + grace` without a reload; `retry_pending` maps to its
   message; the native group-text tests are inverted; `retry_window_closed` has
   copy.
8. E2E: the one-to-one retry flow end to end - a 30003 shows "Phone unreachable -
   will retry" with no Retry button, then the retry's own bubble replaces it. No
   one-to-one retry spec exists today. The relay 30003 spec still passes.

## 7. For Cameron at review

- **Copy to approve:** "Phone unreachable" (no promise), "Phone unreachable -
  will retry", "Retry skipped - message too old" (a relay rung declined at send
  time), and "A retry is already scheduled for this message."
- **One visible difference to confirm:** a relay retry declined when it is
  SCHEDULED reads "Phone unreachable (error 30003)", while one declined at SEND
  time reads "Retry skipped - message too old". The alternative is to write the
  original 30003 onto the rung so both read the same, at the cost of the per-gate
  close-code rule the relay design uses everywhere else.
- **Sequencing with `feat/send-outcome-reconcile`** (section 5): which lands first.

## 8. Out of scope

- A real retry for native group texts.
- Alarm thresholds (Q4's original question) and a manual retry for relay legs.
- Polling for sent-but-unconfirmed legs.
- Showing a one-to-one retry's outcome in broadcast results (a retry drops
  `broadcastId` today).
- The relay stranded-claim window (`relay-retry-stranded-claim-window`, low).

## 9. Residuals

- The relay send waits on an unbounded token bucket after the job's last gate
  (`relayFanOut.ts:1360`); a long throttle could push a send slightly past the
  window.
- The promise can linger up to 60 seconds past `retry_due_at + grace` (ticker
  granularity).
- A stale browser tab can still manually retry an original that an automatic retry
  already replaced (today's behavior; the screen hides replaced bubbles).
- A retry refused at send time (opt-out, manual mode, breaker) keeps its promise
  until it expires.
