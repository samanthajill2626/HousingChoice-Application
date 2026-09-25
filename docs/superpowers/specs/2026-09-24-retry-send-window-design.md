# Retry send window - design

Date: 2026-09-24. Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`,
cut from `main` @`685f2ede`. Status: DRAFT 5 - adversarial review closed after
round 4 returned precision edits only, all folded in here
(`docs/superpowers/reviews/2026-09-24-retry-send-window/`). For Cameron's review.

| sev | issue | this branch |
| --- | --- | --- |
| low | `group-text-30003-leg-retry-promise-unverified` | **closes** |
| - | (unfiled) a late 30003 re-sends hours- or days-old content | **closes** - the ruling itself |
| - | (unfiled) on manual-mode threads the screen promises a retry that is always refused | **closes** |
| - | (unfiled) a manual Retry during an automatic retry's wait texts the member twice | **narrows**; the rest is filed as `manual-retry-double-send-residual-windows` (new, low) |
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

**No automatic retry of a carrier-30003 failure is sent more than 15 minutes after
the original message went out. The screen promises a retry only after one has
actually been scheduled, and stops promising it within `RETRY_PROMISE_GRACE_MS`
plus one ticker interval after it was due, measured on the server's clock.**

"Automatic retry" means the two machine-initiated resend paths: the relay (masked
group) retry ladder and the one-to-one `messaging.retrySend` chain. A staff member
pressing Retry is a new human send; the window never limits it, and it starts a
window of its own.

Two named exceptions, both in section 9: a retry with no usable origin - a relay
slot without `sentAt`, a rung claimed before this deploy, an origin that does not
parse - is not windowed (D5), so its send has no deadline; and while a retry's
outcome is pending reconcile, its promise stays up until it resolves (section 5,
requirement 3).

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
- **The promise.** The one-to-one reason reads "Phone unreachable - will retry
  (error 30003)" for EVERY 30003, keyed by the code alone
  (`dashboard/src/routes/contact/deliveryStatus.ts:778`, with the template's tail):
  false after the third retry fails, false on manual-mode threads, and false for
  native group texts, where no retry exists. On the broadcast result badge
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`) it reflects that a
  broadcast recipient's 30003 IS retried, but the badge never learns the outcome.
- **The double send.** The manual Retry button shows on any failed one-to-one
  bubble (`dashboard/src/routes/contact/Timeline.tsx:1341`), including during an
  automatic retry's wait, and the retry route checks only that the message failed
  (`app/src/routes/api.ts:1592`). Pressing it mid-wait texts the member twice.
- **Lineage after the send.** The one-to-one retry job annotates `retry_of` and
  `retry_attempt` AFTER the send (`retrySend.ts:221-229`), an accepted race: a
  fast 30003 on the retry can read no `retry_attempt` and reset the cap.
- **The relay throttle.** The relay send waits on the shared token bucket
  (`app/src/jobs/relayFanOut.ts:1360`), unbounded; `sendMessage` and `retrySend` do
  not wait on it.

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
  dateCreated, `relayFanOut.ts:1457`). NOT the root row's timestamp: that is
  receipt or compose time, and for a message held while a group connects it can
  precede the real send by a long time (`app/src/routes/api.ts:1710`). Carried
  forward on every retry row as `relay_retry_window_start`. A retry row WITHOUT it
  (claimed before this deploy) is never re-derived from its own slot - that would
  restart the window; D5 applies instead.
- A manual Retry never copies `retry_window_start`: a human chose to send now.

**D3. Relay: check when claiming, with the grace.** Before claiming rung N,
compute when it would send (now plus rung N's resolved backoff). If
`send time + RETRY_JOB_GRACE_MS > origin + RETRY_SEND_WINDOW_MS` (grace = 60
seconds, absorbing queue delay), the rung is not claimed. That decision sits after
the cap check and before the claim's append (`twilio.ts`, between 2763 and 2781),
and resolves in this order:
1. **Already claimed?** A strongly consistent read of the rung's deterministic
   `sid#` pointer (`relayRetryProviderSid`, `relayRetryClaim.ts:33-35`). Today that
   read is private to the repository's append dedupe (`messagesRepo.ts:1960-1974`);
   `MessagesRepo` exposes it. If the rung exists, the outcome is `already_claimed`
   (WARN): a duplicate callback near the edge must not log a false dead end.
2. **Would a job gate refuse it?** On this decline path only - it is rare - the
   claim reads what the job's four gates read (`relayRetryLeg.ts:491-555`): the
   conversation (its status, its roster, and the member's current number,
   compared by digest) and the member's suppression, run in the job's own order -
   group open, on the roster, number unchanged, not opted out - so "that gate's
   code" is deterministic when two apply. Everything needed is already in scope
   at the claim (`relayMemberKey`, `isMemberSuppressed`, `normalizeToE164`,
   `relayRetryDigest`, the contacts and conversations repositories, and the
   claim's own `destDigest`). If any gate would refuse, the outcome is the
   existing `gate_refused` with that gate's code, logged at WARN per Cameron's Q1
   ruling (`isTerminalRelayLegFailure`, `twilio.ts:433-446`, adds `gate_refused`
   to its WARN set; at the claim it arises only here). No rung exists to carry
   the gate's close code, so the leg shows the plain failure (D8). A read that
   FAILS on this path is the claim's existing `claim_failed`: ERROR, a 5xx and a
   Twilio redelivery (`twilio.ts:3000-3007`, `:3176-3198`), not a WARN.
3. **Otherwise** the new outcome `window_closed`, ERROR (D9).
Every branch leaves the member's slot exactly as `cap_exhausted` does: terminal on
30003, no new retry row, no enqueue, no claim SSE.

**D3a. One-to-one: the arm schedules only a retry that can run.** In order:
1. A `group_text` conversation never schedules (D11); WARN.
2. If an automated send to this conversation would be refused right now - the
   kill switch, an opt-out, or manual mode, previewed with the existing
   `evaluateScheduledSendSuppression` (`app/src/services/scheduledSendSuppression.ts:52-68`)
   - schedule nothing, stamp nothing, and log WARN (the job's refusal level today).
   The bubble shows the plain failure with a live Retry button: on manual-mode
   threads this keeps today's only working retry path.
3. The existing cap: exhausted retries log ERROR, as today.
4. The window: schedule only if `now + backoff + RETRY_JOB_GRACE_MS <=
   origin + RETRY_SEND_WINDOW_MS`; otherwise log ERROR (D9) and schedule nothing.
5. Otherwise enqueue, then stamp and emit (D7).
**Failure semantics:** these reads are new - today the arm reads nothing before
enqueueing (`twilio.ts:3353-3368`), runs only on the status transition (`:3343`),
and swallows errors (`:3524-3528`). So a failed conversation or contact read, or a
missing or unparseable origin, FAILS OPEN: log WARN and schedule WITHOUT stamping.
Scheduling is safe because the job's `sendMessage` re-applies the kill switch,
opt-out, manual mode and the `group_text` refusal at send time
(`sendMessage.ts:286-300`, `:307-318`, `:348-349`); not stamping keeps the screen
from promising a retry nothing could check. The breaker and a soft-deleted contact
are not previewable (the preview omits them by design); a retry refused for those
at send time is a section 9 residual.

**D4. Check again right before sending.** The job checks
`now <= origin + RETRY_SEND_WINDOW_MS`, strictly (the grace was spent at
scheduling).
- Relay job: the check is the LAST gate before the send (after the opt-out gate)
  and closes the rung with a new close code, `retry_window_closed`, through the
  pre-send refusal path (`refuseGate`). The job also passes its send deadline (the
  window's end) into `sendOneRelayLeg`, whose token-bucket acquire becomes bounded
  for this caller (`acquire(1, { timeoutMs })`, `app/src/lib/tokenBucket.ts`; the
  group-send precedent, `app/src/services/groupSend.ts:504`). A timeout sends
  nothing, and the job closes the rung `retry_window_closed`. Its path must be
  explicit, because today a `TokenBucketBusyError` there would escape: the
  acquire (`relayFanOut.ts:1360`) sits outside the unit's only try (`:1385-1390`),
  the unit lets unclassified errors throw (`:1246-1248`), the job has no catch
  around the call (`relayRetryLeg.ts:575-598`) and its execution marker is already
  set, so the rung would strand at `queued`. The timeout therefore surfaces as a
  distinct outcome (or a job-side catch of that error) BEFORE the unit's
  `attempted` aggregation write (`:1380-1382`), closes through `refuseGate`
  (nothing was attempted), and is never mapped to `transient`, whose branch
  assumes a provider refusal. The fan-out passes no deadline and is unchanged.
  The transient re-enqueue
  (`relayRetryLeg.ts:643-646`) re-checks and closes instead of re-enqueueing once
  past the window.
- One-to-one job: checks before `sendMessage` and ends the chain without sending.
  The one-to-one send does not wait on the bucket.

**D5. A missing or unparseable origin fails open.** A relay slot with no
`sentAt`, a retry row without `relay_retry_window_start` (claimed before this
deploy), or an origin that does not parse skips the window check and logs a WARN
naming the gap. The new relay field is OPTIONAL in the job's lineage check: that
check throws after the execution marker is set, so a required field would silently
drop every rung claimed before the deploy. A one-to-one row with no
`retry_window_start` uses its own `provider_ts`.

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
enqueue, stamp, emit - a stamp followed by a failed enqueue would promise a retry
that never comes, and `annotateMessage` cannot remove a stamp. The cost of that
order is the lost-stamp case: if the stamp write fails, the retry still runs with
no promise and no guard (section 9). The stamp reaches the dashboard through the
contact-timeline projection (`app/src/routes/contactTimeline.ts:406-463`) and the
dashboard type (`dashboard/src/api/types.ts:2479`).

**D8. What the screen says.**
- **The rule, for the one-to-one bubble and the share results row:** a 30003
  promises a retry ONLY while the failed message carries a live `retry_due_at`,
  never from the retry count. After this branch a 30003 declined by the window or
  by D3a still has "retries remaining" by count while no retry is scheduled. The
  relay promise is not covered by this rule: it stays governed by its live rung
  (`dashboard/src/routes/contact/relayRetryJoin.ts:370-377`).
- **The reason API:** `deliveryReason` gains a `retryScheduled` option. With it,
  code 30003, and `relay` NOT set, the reason is "Phone unreachable - will retry",
  checked ahead of the media and base maps, so an MMS one-to-one bubble with a
  live stamp still promises. Without it, the base 30003 reason is "Phone
  unreachable". The template's `(error 30003)` tail is appended as today in both
  cases.
- **The relay map keeps its 30003 entry** (the same words as the new base), and
  `relay` wins over `retryScheduled`: a relay leg never promises through the
  one-to-one option. The order test (`deliveryStatus.test.ts:761-767`) is
  rewritten to pin exactly that. Because `relay` wins, the one-to-one chip must
  NEVER pass `relay`: the contact page's `rosterKind` defaults to `'relay'`
  (`Timeline.tsx:1790`, `:906`), and the chip deliberately omits the flag today
  ("DELIBERATELY no `relay` flag here", `Timeline.tsx:973-980`). That rationale
  survives D12's rewrite of the comment.
- The base wording is what shows on native group-text legs, rollups and message
  rows, and on a one-to-one bubble whose retries ran out, was declined, or sits on
  a manual-mode thread.
- **A one-to-one bubble's promise is live** only while the SERVER's clock is
  before `retry_due_at + RETRY_PROMISE_GRACE_MS` (2 minutes). The dashboard
  estimates the server's clock from its latest fresh API response rather than
  trusting the browser's clock, so a skewed browser clock does not change how long
  the promise shows. Either route is the plan's, and each has a trap: the
  response's `Date` header stays fresh on a 304 but the API client discards
  response headers today (`dashboard/src/api/client.ts:92-126`), so it must expose
  them; a server-now body field goes stale on a 304 (Express's default weak ETag,
  and API JSON carries no `Cache-Control`), so it needs `Cache-Control: no-store`
  on the timeline route. The error is then the `Date` header's one-second
  resolution plus one tick.
- **The ticker reads the same clock.** Its arming predicate must use the same
  server-clock estimate as the bubble (the file's own rule: a predicate over the
  presenter's functions, never a shape test, `Timeline.tsx:768-775`); otherwise,
  on a fast browser clock, the ticker disarms while the bubble is still live and
  the promise never expires on screen.
- The promise expires on screen without a reload: a one-to-one bubble with a live
  promise joins the Timeline's existing ticker (today one-to-one bubbles never
  tick, `Timeline.tsx:859-899`, pinned by `Timeline.ticker.test.tsx:412-418`).
  Expiry lands within the ticker's 60 seconds.
- **The share results row** (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`)
  reads only the broadcast slot, which has no `retry_due_at`. On this branch alone,
  the base wording therefore removes that row's promise even while a retry IS
  scheduled - under-promising, never false. Reading `retry_due_at` from the failed
  message belongs to `feat/share-skip-fix`'s results path, which already reads that
  message (section 5). The row's copy table is that branch's.
- New and touched copy is ASCII (the current string's em dash becomes a hyphen).
- **Relay, per the ruling - every declined retry shows as a plain failed attempt.**
  At rung 1 a claim-time decline (window or gate) leaves no rung, and the leg reads
  "Phone unreachable (error 30003)". At rungs 2 and 3 the leg goes terminal through
  the join, as at `cap_exhausted`. A job-time decline closes the rung with
  `retry_window_closed` (kept for data and logs), and the join's terminal step
  treats that code as carrying NO display code, so the original's 30003 stands
  (`relayRetryJoin.ts:405-415`) and the leg reads "Phone unreachable (error
  30003)", the same words as a claim-time decline. `INTERNAL_CODE_REASONS` also
  gains a no-tail fallback entry, "Not retried - message too old"
  (`deliveryStatus.ts:913-935`), so a future surface that renders the rung's code
  directly still prints prose and the map's no-tail rule (`:878-882`) holds; no
  current surface renders it.

**D9. Logging.** A window decline where no human-action gate applies is a dead
end - the member never got the text - so it logs one ERROR, like `cap_exhausted`
and the exhausted-retries line today:
- relay claim: the `window_closed` outcome, ERROR through
  `isTerminalRelayLegFailure` (not in its WARN set);
- relay job: the `retry_window_closed` close (the gate or the bounded acquire's
  timeout), ERROR;
- one-to-one arm and job: one ERROR line each, naming `window_closed`.
WARN, not ERROR: a D3a skip; a relay claim that finds a job gate would refuse
(`gate_refused`, D3); `already_claimed`; a missing or unparseable origin (D5); and
a failed read in the one-to-one arm (D3a, which then schedules). A failed read on
the relay claim's decline path is the existing `claim_failed`, ERROR (D3). The
per-callback `delivery_failed` marker and every alarm threshold are unchanged.

**D10. The manual Retry guard** (Cameron's option 1, `rulings.md`).
- Screen: the Retry button is hidden while the one-to-one promise is live (D8).
- Server: the retry route refuses with 409 `retry_pending` while
  `retry_due_at + RETRY_PROMISE_GRACE_MS` is in the future on the server's clock
  (after its not-failed check, `api.ts:1592-1595`). The dashboard maps
  `retry_pending` to "A retry is already scheduled for this message." (every
  unmapped 409 reads the generic "Couldn't send" today, `Timeline.tsx:86-131`).
- `RETRY_PROMISE_GRACE_MS` is one value, mirrored in the dashboard and pinned by a
  test (the media-type mirror precedent,
  `dashboard/src/routes/contact/mediaTypeMirror.test.ts`).
- Nothing else. The guard is time-based; section 9 and
  `manual-retry-double-send-residual-windows` name what it leaves.

**D11. Native group text.** No retry exists for a native group text. Whenever the
conversation read succeeds, the one-to-one arm refuses to schedule one for a
`group_text` conversation (the conversation is read anyway for D3a), logging WARN.
If the read fails, D3a fails open, and the job's `sendMessage` refuses the
`group_text` send (`sendMessage.ts:297-300`). Whether a classic callback can reach
that arm for a group text at all is live Twilio behavior no build can settle: the
repo asserts both sides (`app/src/services/groupReceipts.ts:3-10` against
`twilio.ts:3422-3429`, `:3477-3479`), and a synthetic test drives the arm with a
group row (`app/test/twilioStatusWebhook.test.ts:1420-1463`). The false promise on
screen is copy: D8's base wording removes it from the leg, the rollup and the
message row. The tests that pin the carve-out (`deliveryStatus.test.ts:419` and
`:738`, `Timeline.delivery.test.tsx:516` and `:577`) are INVERTED, not deleted.

**D12. Comments that now lie are corrected.**
- `deliveryStatus.ts:824-858`: the "NO RELAY RETRY EXISTS" rationale, written
  before the relay ladder, and "the 1:1 entry above stays byte-for-byte ... a 1:1
  30003 retry genuinely does send". The relay map itself stays (D8); its comment
  says why it now exists: a relay leg never promises through `retryScheduled`.
- `deliveryStatus.ts:863-876` (the `relay` option's doc) and `:959-969`
  (`deliveryReason`'s order comment), which gain `retryScheduled`'s place in the
  order.
- `twilio.ts:316-341` (the 30003 carve-out rationale, "the one path where the
  promise holds"), and `:3422-3429` and `:3477-3479` (native group texts "ARE
  REACHABLE HERE"), reworded to D11's position.
- `Timeline.tsx:973-979` and `:1272-1275` (the group-text "retry is real" notes).
  The rewrite at `:973-980` keeps its other half: the one-to-one chip passes no
  `relay` flag, now because `relay` would also switch off the promise (D8).
- D6 makes these false: `sendMessage.ts:234-240`, `messagesRepo.ts:725-731` and
  `:2262-2265`, `retrySend.ts:9-10` and `:221-225`.
- Test and doc comments: `deliveryStatus.test.ts:721-737`, `:744-751`, `:762-763`,
  `Timeline.delivery.test.tsx:460-465`, `:509-515`, `:570-576`,
  `StatChips.test.tsx:120-127`, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-22`,
  `e2e/support/selectors.md:49`.

**D13. Test seams and fixtures.**
- Unit tests inject the clock.
- A one-to-one retry backoff lane seam, `E2E_SEND_RETRY_BACKOFF_MS`, honored only
  when `JOBS_QUEUE_URL` is unset (the relay's `E2E_RELAY_RETRY_BACKOFF_MS` guard,
  `relayRetryLeg.ts:190-196`), set in the lane's `childEnv`
  (`scripts/e2e-session.mjs:254-272`). `feat/share-skip-fix` plans the same seam;
  whichever lands first builds it and the other reuses it.
- If an e2e needs a short window, `E2E_RETRY_SEND_WINDOW_MS` has the same guard,
  and its lane value must exceed the longest lane rung backoff plus
  `RETRY_JOB_GRACE_MS`, with margin, in BOTH lanes - otherwise it declines every
  rung.
- Fixtures: one-to-one fixtures with fixed past `provider_ts`
  (`app/test/twilioStatusWebhook.test.ts:59`) move to realistic times. Relay
  fixtures without a slot `sentAt` (`app/test/relayRetryClaim.webhook.test.ts:157-161`,
  `:174-178`) pass through D5 unchanged; the relay window tests need NEW fixtures
  with a slot `sentAt`.

## 4. Every surface the plan must cover

The plan enumerates each as a task or a watch item (research sweep plus review
rounds 1-3):

- **Writers of automatic retries:** relay claim and enqueue (`twilio.ts:2781`,
  `:2842`); relay send and transient re-enqueue (`relayRetryLeg.ts:575`,
  `:643-646`), including `sendOneRelayLeg`'s token-bucket acquire, which gains an
  optional deadline (`relayFanOut.ts:1360`, the bounded `acquire` in
  `app/src/lib/tokenBucket.ts`); one-to-one enqueue (`twilio.ts:3364`); one-to-one
  send and lineage (`retrySend.ts:200-229`), through the `sendMessage` input and
  append path (`sendMessage.ts:193-241`, `:398-428`); handler registration
  (`app/src/jobs/registerHandlers.ts:47`, `:60`); the lane backoff overrides
  (`scripts/e2e-session.mjs:254-272`, the relay one and the new one-to-one one).
  Manual: the route's checks and append (`api.ts:1571-1595`, `:1651`).
- **Where the new checks and reads land:** the relay claim (`twilio.ts:2763-2781`),
  including its decline-path conversation and suppression reads (D3 step 2); the
  relay job's gates (`relayRetryLeg.ts:491-555`); the one-to-one arm
  (`twilio.ts:3350-3369`); the one-to-one job's read of the original
  (`retrySend.ts:112-120`).
- **Readers of retry lineage:** server `twilio.ts:2757`, `:2761`, `:2776`, `:2825`,
  `:3129`, `:3353`; `relayRetryLeg.ts:268-292`, `:372`; `messagesRepo.ts:2265-2284`,
  `:2335`, `:2912-2918`; `contactTimeline.ts:442`. Dashboard `types.ts:2308-2315`,
  `:2494`, `:2509-2515`; `useRelayThread.ts:101-142`; `relayRetryJoin.ts:135-164`,
  `:405-415` (the terminal step, which learns `retry_window_closed`), `:453`;
  `Timeline.tsx:885`, `:1077`, `:1975-1984`, `:2004-2019`.
- **The promise's clock:** the dashboard API client (`dashboard/src/api/client.ts:92-126`,
  which discards response headers today) if the `Date` route is taken, or the
  timeline route's `Cache-Control` if a server-now field is; the one-to-one chip's
  reason call and the Retry gate (`Timeline.tsx:980`, `:1341`), which read the
  bubble clock derived later (`:1016`); and the ticker's arming predicate
  (`Timeline.tsx:859-899`, `:2101-2104`).
- **Readers of the 30003 copy:** `deliveryStatus.ts:778` and `:859-861` (the relay
  map entry, kept) via the Timeline chip, reason, rollup, row and spoken summary;
  EmailCard; `DeliveryBadge.tsx:31`; StatChips. Tests: those in D11, plus
  `deliveryStatus.test.ts:761-767` (rewritten), `StatChips.test.tsx:129`,
  `Timeline.email.test.tsx:114`, `Timeline.delivery.test.tsx:528-536` and `:593`.
- **Vocabulary:** the `RelayRetryCloseCode` union (`relayRetryLeg.ts:91-97`) and its
  gate-case table (`app/test/relayRetryLeg.test.ts:307` onward) gain
  `retry_window_closed`; the `RelayRetryClaimOutcome` union's exhaustive test
  (`app/test/relayRetryClaim.test.ts:51-88`) moves from thirteen values to
  fourteen; `isTerminalRelayLegFailure`'s WARN set gains `gate_refused`; the
  internal-code copy test (`deliveryStatus.test.ts:1648-1668`) gains the no-tail
  fallback entry; `e2e/support/selectors.md:49` documents the prose family.
- **Repository and test doubles:** `MessagesRepo` gains a public, strongly
  consistent `sid#` pointer read (today private, `messagesRepo.ts:1960-1974`), which
  the webhook harness fake must implement too; the harness copy of
  `annotateMessage` (`app/test/helpers/twilioWebhookHarness.ts:1338`); and the
  harness fake `append`, an explicit field allowlist (`:1081-1152`) that would
  silently drop the new append-time fields and let a "carried origin" test pass
  vacuously through D5.
- **Seeds and dev seams:** none write retry fields today (research sweep); the
  plan confirms none are added.

## 5. Concurrent work

Both branches below are at the spec stage in other sessions and keep moving; the
plan re-reads them before it is written. The couplings are stated as requirements
on ANY path, so they hold whatever those branches' mechanics become. Whichever
branch lands second carries each one.

- **`feat/share-skip-fix`** (v5 @`3a6a1a06`, at its human gate):
  - It edits the same one-to-one retry send call (`retrySend.ts:200-207`) and the
    same retry route (`api.ts:1564-1661`): both retries will carry the share, so
    `retrySend.ts` and `api.ts` merge textually with D6 and D10.
  - Copy on the share results row: its table keeps "Phone unreachable - will
    retry" for "30003 with retries remaining" and adds "Phone unreachable -
    retries exhausted". "Retries remaining" by count no longer means a retry is
    scheduled (D3a, the window), so its derivation follows D8's rule instead: the
    failed message's live `retry_due_at`, which its results path already reads the
    message to find. The row's wording stays that branch's.
  - It plans the same one-to-one backoff seam as D13.
  - Its lean seed gains a switched-off (manual-mode) tenant conversation for its
    e2e checks; this branch's one-to-one e2e (test intention 8) must not use it,
    because D3a skips the retry there by design.
  - Its import change creates one-to-one rows in `auto`; section 2's manual-mode
    statement then describes pre-existing rows only. D3a reads the live switch,
    so both orders hold.
  - It accepts the manual double send as today's behavior; D10 narrows it.
- **`feat/send-outcome-reconcile`** (revision 5 @`922675db`, its review closed)
  plans edits to `relayRetryLeg.ts`, `retrySend.ts`, `messagesRepo.ts`,
  `sendMessage.ts` and `deliveryStatus.ts`; retypes `sendMessage`'s errors on the
  input and append path D6 edits; and restructures `sendOneRelayLeg`'s phases,
  which D4's deadline option must survive. Requirements on any path it adds:
  1. A relay rung it re-drives later passes through D4's job-time check, so the
     window bounds it.
  2. Any path that appends a one-to-one retry row (its "adopt") carries
     `retry_of`, `retry_attempt` and `retry_window_start` at append (D2, D6).
  3. Any path that DEFERS a one-to-one retry, or leaves its outcome pending past
     `retry_due_at` (a deferral, or an `unknown` send outcome awaiting reconcile
     checks at about 5 seconds, 30 seconds and 4 minutes), applies D3a's window
     check to any re-schedule and keeps the promise and D10's guard up until the
     retry resolves, by refreshing `retry_due_at` to cover the pending schedule and
     emitting `message.persisted` after each refresh (D7). Otherwise the Retry
     button returns while an automatic text may already be out.
  4. Its filed issue that an unresolved one-to-one retry "leaves the original's
     'will retry' copy standing" changes with D8: the copy now follows
     `retry_due_at`, so requirement 3 is what keeps it truthful.
  5. Its phase table calls the token acquire "best-effort" and defers PREPARE
     failures as `retryable`. That predates D4's bounded acquire, which CAN fail.
     For a relay retry rung, a deadline timeout is TERMINAL whatever phase model
     `sendOneRelayLeg` adopts: nothing is sent and the rung closes
     `retry_window_closed`. Deferring it as `retryable` would re-open a send past
     the window. Test intention 3 is re-run after that merge to catch it.

## 6. Test intentions

1. The window helper: scheduling allowed only with the grace to spare; the job's
   strict boundary at exactly 15 minutes; an unparseable origin fails open.
2. Relay claim: a 30003 whose rung send plus grace lands after `sentAt + 15 min`
   declines with `window_closed` - ERROR, no retry row, no enqueue, slot
   unchanged; the same situation with the rung already claimed (read
   consistently) yields `already_claimed` (WARN); with any of the four job gates
   refusing (group closed, member removed, number changed, opted out) it yields
   `gate_refused` with that gate's code (WARN), at rung 1 and at rungs 2-3 and for
   a team send alike, and with two gates refusing it reports the one the job
   checks first; a read failure on that path is `claim_failed` (ERROR, 5xx);
   inside the window it claims as today; rung 2's claim
   measures from the carried origin (with the harness append preserving the new
   field).
3. Relay job: past the window it closes with `retry_window_closed` - ERROR, one
   SSE for the root, no send; the join renders that leg as "Phone unreachable
   (error 30003)"; a bounded acquire that times out closes `retry_window_closed`
   through `refuseGate` without sending, never through the transient branch and
   never leaving the rung `queued`; a transient pass past the window closes
   instead of
   re-enqueueing; a pre-deploy rung without the field still runs (WARN); the
   fan-out's acquire is unbounded as before.
4. One-to-one arm: `group_text` schedules nothing (WARN); a manual-mode, opted-out
   or kill-switched conversation schedules nothing and stamps nothing (WARN); a
   failed conversation or contact read schedules WITHOUT a stamp (WARN); exhausted
   retries log ERROR as today; past the window it declines (ERROR, no enqueue, no
   stamp); inside it enqueues, stamps `retry_due_at` and emits; a failed enqueue
   leaves no stamp.
5. One-to-one job: past the window it ends without sending; the new retry row
   carries `retry_of`, `retry_attempt` and `retry_window_start` at append, with
   nothing annotated afterwards.
6. Manual route: 409 `retry_pending` before `retry_due_at + grace` (server clock),
   allowed after; a manual retry row has no `retry_window_start`.
7. Dashboard:
   - `deliveryReason` with `retryScheduled`, code 30003 and no `relay` promises,
     ahead of the media map (an MMS one-to-one 30003 still promises); a relay leg
     never promises, even with `retryScheduled`; without it no surface promises;
     the no-tail fallback copy for `retry_window_closed` is present.
   - A one-to-one bubble with a live `retry_due_at`, rendered with the DEFAULT
     `rosterKind` (as the existing guard test does,
     `Timeline.delivery.test.tsx:575-593`), shows "Phone unreachable - will retry
     (error 30003)" and no Retry button; one without (manual mode, declined,
     exhausted) shows the plain failure and the Retry button.
   - The ticker arms on the same server-clock estimate as the bubble while the
     promise is live, and the promise disappears after `retry_due_at + grace` on
     the server's clock without a reload - including on a fast browser clock.
   - Skew: a browser clock 10 minutes fast or 10 minutes slow shows the promise
     for the same real duration as a correct one.
   - `retry_pending` maps to its message; the native group-text tests are
     inverted; the mirrored grace constant is pinned.
8. E2E, using the one-to-one backoff seam and a tenant whose conversation is not
   in manual mode: a 30003 on a one-to-one text shows "Phone unreachable - will
   retry (error 30003)" with no Retry button, then the retry's own bubble replaces
   it (no one-to-one retry spec exists today). The relay 30003 spec still passes.

## 7. For Cameron at review

- **Copy to approve:** "Phone unreachable (error 30003)" (the base 30003 wording
  everywhere, no promise), "Phone unreachable - will retry (error 30003)" (a
  one-to-one bubble while a retry is scheduled), "A retry is already scheduled
  for this message." (a stale tab's manual Retry), and "Not retried - message too
  old" (a fallback no current screen shows).
- **One visible change to confirm:** a LATE 30003 that arrives after a human
  action - the group was closed, the member removed, their number changed, or they
  opted out - used to show "Not retried - group closed" (or "no longer in this
  group", "number changed since", "opted out"). Now no retry step is created, so
  it shows the plain "Phone unreachable (error 30003)", per the ruling that a
  declined retry is a plain failed attempt.
- **One rule across specs:** the share results row's "will retry" follows D8 (a
  scheduled retry), not share-skip-fix's retry count; until share-skip-fix reads
  `retry_due_at`, that row shows no promise (section 5, D8).
- **Sequencing** with `feat/share-skip-fix` and `feat/send-outcome-reconcile`
  (section 5): which lands first.

## 8. Out of scope

- A real retry for native group texts.
- Alarm thresholds (Q4's original question) and a manual retry for relay legs.
- Polling for sent-but-unconfirmed legs.
- The share results row's copy table (share-skip-fix's surface; D8 sets only the
  rule it follows).
- A conditional-claim fix for the remaining manual double-send windows
  (`manual-retry-double-send-residual-windows`).
- The relay stranded-claim window (`relay-retry-stranded-claim-window`, low).

## 9. Residuals

Each is filed or accepted here, so it outlives this spec's freeze.

- **Manual double send** (`manual-retry-double-send-residual-windows`): the guard is
  time-based. A Retry can still double-send when it reaches the route before the
  `retry_due_at` stamp is written; for the whole wait if the stamp write fails
  (D7) or if D3a failed open and scheduled without a stamp; after an expired
  promise while the automatic job is running late; from a
  stale tab on an original an automatic retry already replaced; and while a retry's
  outcome is pending, unless the path that left it pending honors section 5's
  requirement 3.
- **Pending reconcile copy** (accepted): while a retry's outcome is pending
  reconcile, the bubble keeps "will retry" although its text may already be out.
  One field keys both the copy and the guard, and the guard is what prevents a
  double send.
- **Refused at send time:** a retry refused for a reason D3a cannot preview (the
  breaker, a soft-deleted contact) keeps its promise until it expires.
- **No usable origin** (accepted, D5): a relay slot without `sentAt`, a rung
  claimed before this deploy, or an origin that does not parse is not windowed,
  so that retry's send has no deadline. Production writes `sentAt` on every fanned
  leg, and pre-deploy rungs finish within minutes of the deploy.
